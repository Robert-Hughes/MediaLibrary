import { useEffect, useRef, useState } from "react";
import type {
  DraftEditsStore,
  ImageMetadataState,
  ImageMetadataStore,
  MetadataDraftCollection,
  PhotoInfo,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import type {
  SearchDraftEntry,
  SearchMetadataState,
  SearchSchemaLabel,
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "../workers/searchWorkerProtocol";
import { resolveTagInfosExact } from "./useTagInfo";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const INITIAL_REPLAY_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;

export function toSearchMetadataState(
  meta: ImageMetadataState,
): SearchMetadataState {
  if (meta === "loading") return "loading";
  return Object.values(meta).map((entry) => {
    const { id, ...value } = entry;
    return { id, value };
  });
}

export function toSearchDraftEntries(
  collection: MetadataDraftCollection | undefined,
): SearchDraftEntry[] | undefined {
  return collection
    ? Object.values(collection).map(({ id, edit }) => ({ id, edit }))
    : undefined;
}

function idsFromMetadata(meta: SearchMetadataState): SchemaDefinitionId[] {
  return meta === "loading" ? [] : meta.map(({ id }) => id);
}

function labelsFromResolved(
  ids: readonly SchemaDefinitionId[],
  resolved: Record<string, TagInfo | null>,
): SearchSchemaLabel[] {
  const labels = new Map<string, SearchSchemaLabel>();
  for (const id of ids) {
    const token = schemaDefinitionIdToken(id);
    const info = resolved[token];
    if (info && !labels.has(token)) {
      labels.set(token, {
        id: info.id,
        group: info.group,
        name: info.name,
        description: info.description,
      });
    }
  }
  return Array.from(labels.values());
}

/**
 * Subset of the DOM Worker interface that this hook actually uses.  Lets
 * tests substitute an in-thread fake.
 */
export interface SearchWorkerLike {
  postMessage(msg: SearchWorkerInbound): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<SearchWorkerOutbound>) => void) | null;
}

export interface UseSearchWorkerArgs {
  photos: PhotoInfo[];
  imageMetadataStore: ImageMetadataStore;
  draftEditsStore: DraftEditsStore;
  query: string;
  /** Default 150ms.  Tests pass 0 to bypass the debounce. */
  debounceMs?: number;
  /** Injected factory for tests.  Production caller passes the real spawner. */
  createWorker: () => SearchWorkerLike;
}

export interface UseSearchWorkerResult {
  /**
   * Set of matched relative_paths from the most recent completed query, or
   * null when no result has been received yet (during initial spin-up).
   * `displayPhotos` should fall back to the unfiltered list while null.
   */
  matched: Set<string> | null;
  /** True between a submitted query and its (non-stale) result. */
  pending: boolean;
}

function diffPhotoPaths(
  prev: PhotoInfo[],
  next: PhotoInfo[],
): {
  upserts: PhotoInfo[];
  deletions: string[];
} {
  const prevByPath = new Map(prev.map((p) => [p.relative_path, p]));
  const nextPaths = new Set<string>();
  const upserts: PhotoInfo[] = [];
  for (const p of next) {
    nextPaths.add(p.relative_path);
    const before = prevByPath.get(p.relative_path);
    if (
      !before ||
      before.filename !== p.filename ||
      before.date_modified !== p.date_modified ||
      before.date_created !== p.date_created
    ) {
      upserts.push(p);
    }
  }
  const deletions: string[] = [];
  for (const p of prev) {
    if (!nextPaths.has(p.relative_path)) deletions.push(p.relative_path);
  }
  return { upserts, deletions };
}

function photoToFields(p: PhotoInfo) {
  return {
    relative_path: p.relative_path,
    filename: p.filename,
    date_modified: p.date_modified,
    date_created: p.date_created,
  };
}

/**
 * React bridge between the list-view search box and the off-thread
 * `SearchIndex`.  Owns:
 *  - one worker instance for the hook's lifetime;
 *  - subscriptions to ImageMetadataStore + DraftEditsStore that forward
 *    every mutation as an `UPSERT_*` message;
 *  - photo-list diffing that posts `UPSERT_PHOTO` / `DELETE_PATH` and then
 *    re-submits the current query so the displayed results stay in sync
 *    when photos arrive mid-search (the user sees a brief "pending" spin
 *    while results refresh);
 *  - a request-id ratchet that drops stale `RESULT` messages.
 *
 * The store-instance refs are watched (re-init on change) so that scan
 * reset — which swaps in a fresh `ImageMetadataStore` — also resets the
 * worker's index.
 */
export function useSearchWorker(
  args: UseSearchWorkerArgs,
): UseSearchWorkerResult {
  const {
    photos,
    imageMetadataStore,
    draftEditsStore,
    query,
    debounceMs = 150,
    createWorker,
  } = args;

  const workerRef = useRef<SearchWorkerLike | null>(null);
  const workerGenerationRef = useRef(0);
  const reqIdRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const prevPhotosRef = useRef<PhotoInfo[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const metaRevisionsRef = useRef(new Map<string, number>());
  const draftRevisionsRef = useRef(new Map<string, number>());

  const [matched, setMatched] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState(false);

  /** Submit the current query immediately, bumping the request id. */
  const submitNow = (q: string) => {
    if (!workerRef.current) return;
    const id = ++reqIdRef.current;
    setPending(true);
    workerRef.current.postMessage({ type: "QUERY", id, query: q });
  };

  // ── Spawn worker once ───────────────────────────────────────────────
  useEffect(() => {
    const w = createWorker();
    workerGenerationRef.current += 1;
    workerRef.current = w;
    w.onmessage = (ev) => {
      const msg = ev.data;
      if (msg.type !== "RESULT") return;
      if (msg.id !== reqIdRef.current) return; // stale
      setMatched(new Set(msg.matched));
      setPending(false);
    };
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      w.terminate();
      workerRef.current = null;
      workerGenerationRef.current += 1;
    };
    // createWorker is intended to be stable (defined once in the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subscribe to metadata store + cold-start replay ─────────────────
  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    let active = true;
    let initialReplayComplete = false;
    let initialReplayInFlight = false;
    let initialReplayRetryIndex = 0;
    let initialReplayRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const generation = workerGenerationRef.current;
    const isCurrentWorker = () =>
      active &&
      workerRef.current === w &&
      workerGenerationRef.current === generation;
    // Reset and replay the current store contents.  Scan reset swaps in a
    // fresh store instance, which is what re-runs this effect.
    w.postMessage({ type: "CLEAR" });
    w.postMessage({
      type: "INIT_PHOTOS",
      photos: prevPhotosRef.current.map(photoToFields),
    });
    // Exact IDs cross the worker boundary. The existing main-thread cache
    // resolves labels first, then sends entries and search-only labels atomically;
    // labels enrich the haystack but never become identity.
    const initialMeta = Array.from(imageMetadataStore.entries()).map(
      ([path, meta]) => ({
        path,
        meta: toSearchMetadataState(meta),
        revision: metaRevisionsRef.current.get(path) ?? 0,
      }),
    );
    const initialDrafts = Object.entries(draftEditsStore.getAllMetadata()).map(
      ([path, edits]) => ({
        path,
        edits: toSearchDraftEntries(edits) ?? [],
        revision: draftRevisionsRef.current.get(path) ?? 0,
      }),
    );
    const initialMetaIds = initialMeta.flatMap(({ meta }) =>
      idsFromMetadata(meta),
    );
    const initialDraftIds = initialDrafts.flatMap(({ edits }) =>
      edits.map(({ id }) => id),
    );
    const scheduleInitialReplayRetry = () => {
      if (!isCurrentWorker() || initialReplayComplete) return;
      const delay =
        INITIAL_REPLAY_RETRY_DELAYS_MS[
          Math.min(
            initialReplayRetryIndex,
            INITIAL_REPLAY_RETRY_DELAYS_MS.length - 1,
          )
        ];
      initialReplayRetryIndex += 1;
      initialReplayRetryTimer = setTimeout(() => {
        initialReplayRetryTimer = null;
        replayInitialSnapshot();
      }, delay);
    };
    const replayInitialSnapshot = () => {
      if (!isCurrentWorker() || initialReplayComplete || initialReplayInFlight)
        return;
      initialReplayInFlight = true;
      void resolveTagInfosExact([...initialMetaIds, ...initialDraftIds])
        .then((resolved) => {
          if (!isCurrentWorker() || initialReplayComplete) return;
          initialReplayComplete = true;
          initialReplayRetryIndex = 0;
          if (initialReplayRetryTimer) {
            clearTimeout(initialReplayRetryTimer);
            initialReplayRetryTimer = null;
          }
          const metaEntries = initialMeta
            .filter(
              ({ path, revision }) =>
                (metaRevisionsRef.current.get(path) ?? 0) === revision,
            )
            .map(({ path, meta }) => ({ path, meta }));
          w.postMessage({
            type: "INIT_META",
            entries: metaEntries,
            schemaLabels: labelsFromResolved(initialMetaIds, resolved),
          });
          const draftEntries = initialDrafts
            .filter(
              ({ path, revision }) =>
                (draftRevisionsRef.current.get(path) ?? 0) === revision,
            )
            .map(({ path, edits }) => ({ path, edits }));
          w.postMessage({
            type: "INIT_DRAFTS",
            entries: draftEntries,
            schemaLabels: labelsFromResolved(initialDraftIds, resolved),
          });
          submitNow(queryRef.current);
        })
        .catch(() => {
          scheduleInitialReplayRetry();
        })
        .finally(() => {
          initialReplayInFlight = false;
        });
    };
    replayInitialSnapshot();

    const unsubMeta = imageMetadataStore.subscribeAll((path, meta) => {
      const revision = (metaRevisionsRef.current.get(path) ?? 0) + 1;
      metaRevisionsRef.current.set(path, revision);
      const searchMeta = toSearchMetadataState(meta);
      const ids = idsFromMetadata(searchMeta);
      void resolveTagInfosExact(ids)
        .then((resolved) => {
          if (
            !isCurrentWorker() ||
            metaRevisionsRef.current.get(path) !== revision
          )
            return;
          w.postMessage({
            type: "UPSERT_META",
            path,
            meta: searchMeta,
            schemaLabels: labelsFromResolved(ids, resolved),
          });
          submitNow(queryRef.current);
        })
        .catch(() => {
          // A later update retries.
        });
    });
    const unsubDrafts = draftEditsStore.subscribe((changes) => {
      for (const c of changes) {
        const revision = (draftRevisionsRef.current.get(c.path) ?? 0) + 1;
        draftRevisionsRef.current.set(c.path, revision);
        const edits = toSearchDraftEntries(c.edits);
        const ids = edits?.map(({ id }) => id) ?? [];
        void resolveTagInfosExact(ids)
          .then((resolved) => {
            if (
              !isCurrentWorker() ||
              draftRevisionsRef.current.get(c.path) !== revision
            )
              return;
            w.postMessage({
              type: "UPSERT_DRAFTS",
              path: c.path,
              edits,
              schemaLabels: labelsFromResolved(ids, resolved),
            });
            submitNow(queryRef.current);
          })
          .catch(() => {
            // A later update retries.
          });
      }
    });
    return () => {
      active = false;
      if (initialReplayRetryTimer) {
        clearTimeout(initialReplayRetryTimer);
        initialReplayRetryTimer = null;
      }
      unsubMeta();
      unsubDrafts();
    };
  }, [imageMetadataStore, draftEditsStore]);

  // ── Photo list sync + re-submit ─────────────────────────────────────
  useEffect(() => {
    const w = workerRef.current;
    if (!w) {
      prevPhotosRef.current = photos;
      return;
    }
    const { upserts, deletions } = diffPhotoPaths(
      prevPhotosRef.current,
      photos,
    );
    prevPhotosRef.current = photos;
    if (upserts.length === 0 && deletions.length === 0) return;
    for (const p of upserts) {
      w.postMessage({ type: "UPSERT_PHOTO", photo: photoToFields(p) });
    }
    for (const path of deletions) {
      w.postMessage({ type: "DELETE_PATH", path });
    }
    // Re-submit current query so the user sees results refresh (and the
    // pending indicator) when photos arrive mid-search.
    submitNow(queryRef.current);
  }, [photos]);

  // ── Debounced query submit on user typing ───────────────────────────
  useEffect(() => {
    if (debounceMs === 0) {
      submitNow(query);
      return;
    }
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      submitNow(query);
    }, debounceMs);
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [query, debounceMs]);

  return { matched, pending };
}

/**
 * Production worker factory.  Lives here (not inside the hook) so the
 * Vite-specific `new URL` import-meta form is only resolved when the real
 * worker is wanted — tests inject their own factory and never touch this.
 */
export function createSearchWorker(): SearchWorkerLike {
  return new Worker(new URL("../workers/searchWorker.ts", import.meta.url), {
    type: "module",
  }) as unknown as SearchWorkerLike;
}

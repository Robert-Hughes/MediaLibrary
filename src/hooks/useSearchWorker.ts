import { useCallback, useEffect, useRef, useState } from "react";
import type {
  FileMetadataOccurrencesState,
  FileMetadataOccurrencesStore,
  FileInfo,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import type {
  SearchDraftEntry,
  SearchOccurrencesState,
  SearchSchemaLabel,
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "../workers/searchWorkerProtocol";
import { resolveTagInfosExact } from "./useTagInfo";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import type {
  TargetDraftCollection,
  TargetDraftEditsStore,
} from "../targetDraftEdits";
import { frontendNow, logSlowFrontendOperation } from "../frontendPerformance";

const INITIAL_REPLAY_RETRY_DELAYS_MS = [250, 1_000, 5_000] as const;

export function toSearchOccurrencesState(
  occurrences: FileMetadataOccurrencesState,
): SearchOccurrencesState {
  if (!Array.isArray(occurrences)) return "loading";
  return occurrences.map((occurrence) => ({
    schemaId: structuredClone(occurrence.schema_id),
    value: structuredClone(occurrence.value),
    occurrenceId: structuredClone(occurrence.id),
  }));
}

export function toSearchDraftEntries(
  collection: TargetDraftCollection | undefined,
): SearchDraftEntry[] | undefined {
  return collection
    ? Object.values(collection).map(({ target, edit }) => ({
        id: target.schema_id,
        edit,
      }))
    : undefined;
}

function idsFromOccurrences(
  occurrences: SearchOccurrencesState,
): SchemaDefinitionId[] {
  return occurrences === "loading"
    ? []
    : occurrences.map(({ schemaId }) => schemaId);
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
        kind: info.kind,
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
  files: FileInfo[];
  fileMetadataOccurrencesStore: FileMetadataOccurrencesStore;
  targetDraftEditsStore: TargetDraftEditsStore;
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
   * `displayFiles` should fall back to the unfiltered list while null.
   */
  matched: Set<string> | null;
  /** True between a submitted query and its (non-stale) result. */
  pending: boolean;
}

function diffFilePaths(
  prev: FileInfo[],
  next: FileInfo[],
): {
  upserts: FileInfo[];
  deletions: string[];
} {
  const prevByPath = new Map(prev.map((p) => [p.relative_path, p]));
  const nextPaths = new Set<string>();
  const upserts: FileInfo[] = [];
  for (const p of next) {
    nextPaths.add(p.relative_path);
    const before = prevByPath.get(p.relative_path);
    if (
      !before ||
      before.filename !== p.filename ||
      before.media_kind !== p.media_kind ||
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

function fileToFields(p: FileInfo) {
  return {
    relative_path: p.relative_path,
    filename: p.filename,
    media_kind: p.media_kind,
    date_modified: p.date_modified,
    date_created: p.date_created,
  };
}

/**
 * React bridge between the list-view search box and the off-thread
 * `SearchIndex`.  Owns:
 *  - one worker instance for the hook's lifetime;
 *  - subscriptions to authoritative metadata and target-draft stores that forward
 *    every mutation as an `UPSERT_*` message;
 *  - file-list diffing that posts `UPSERT_PHOTO` / `DELETE_PATH` and then
 *    re-submits the current query so the displayed results stay in sync
 *    when files arrive mid-search (the user sees a brief "pending" spin
 *    while results refresh);
 *  - a request-id ratchet that drops stale `RESULT` messages.
 *
 * The occurrence-store reference is watched for defensive re-initialisation,
 * although production preserves its identity across folder scans.
 */
export function useSearchWorker(
  args: UseSearchWorkerArgs,
): UseSearchWorkerResult {
  const {
    files,
    fileMetadataOccurrencesStore,
    targetDraftEditsStore,
    query,
    debounceMs = 150,
    createWorker,
  } = args;

  const workerRef = useRef<SearchWorkerLike | null>(null);
  const workerGenerationRef = useRef(0);
  const reqIdRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const prevFilesRef = useRef<FileInfo[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const occurrenceRevisionsRef = useRef(new Map<string, number>());
  const draftRevisionsRef = useRef(new Map<string, number>());

  const [matched, setMatched] = useState<Set<string> | null>(null);
  const [pending, setPending] = useState(false);

  /** Submit the current query immediately, bumping the request id. */
  const submitNow = useCallback((q: string) => {
    if (!workerRef.current) return;
    const id = ++reqIdRef.current;
    if (q.trim().length === 0) {
      setMatched(null);
      setPending(false);
      return;
    }
    setPending(true);
    workerRef.current.postMessage({ type: "QUERY", id, query: q });
  }, []);

  /** Store/index changes need no React update while search is inactive. */
  const refreshCurrentQuery = useCallback(() => {
    const current = queryRef.current;
    if (current.trim().length === 0) return;
    submitNow(current);
  }, [submitNow]);

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
      w.onmessage = null;
      w.terminate();
      workerRef.current = null;
      workerGenerationRef.current += 1;
    };
    // createWorker is intended to be stable (defined once in the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subscribe to occurrence store + cold-start replay ───────────────
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
      files: prevFilesRef.current.map(fileToFields),
    });
    // Exact IDs cross the worker boundary. The existing main-thread cache
    // resolves labels first, then sends entries and search-only labels atomically;
    // labels enrich the haystack but never become identity.
    const initialOccurrences = Array.from(
      fileMetadataOccurrencesStore.entries(),
    ).map(([path, occurrences]) => ({
      path,
      occurrences: toSearchOccurrencesState(occurrences),
      revision: occurrenceRevisionsRef.current.get(path) ?? 0,
    }));
    const initialDrafts = Object.entries(
      targetDraftEditsStore.getAllMetadata(),
    ).map(([path, edits]) => ({
      path,
      edits: toSearchDraftEntries(edits) ?? [],
      revision: draftRevisionsRef.current.get(path) ?? 0,
    }));
    const initialOccurrenceIds = initialOccurrences.flatMap(({ occurrences }) =>
      idsFromOccurrences(occurrences),
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
      void resolveTagInfosExact([...initialOccurrenceIds, ...initialDraftIds])
        .then((resolved) => {
          if (!isCurrentWorker() || initialReplayComplete) return;
          initialReplayComplete = true;
          initialReplayRetryIndex = 0;
          if (initialReplayRetryTimer) {
            clearTimeout(initialReplayRetryTimer);
            initialReplayRetryTimer = null;
          }
          const occurrenceEntries = initialOccurrences
            .filter(
              ({ path, revision }) =>
                (occurrenceRevisionsRef.current.get(path) ?? 0) === revision,
            )
            .map(({ path, occurrences }) => ({ path, occurrences }));
          w.postMessage({
            type: "INIT_OCCURRENCES",
            entries: occurrenceEntries,
            schemaLabels: labelsFromResolved(initialOccurrenceIds, resolved),
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
          refreshCurrentQuery();
        })
        .catch(() => {
          scheduleInitialReplayRetry();
        })
        .finally(() => {
          initialReplayInFlight = false;
        });
    };
    replayInitialSnapshot();

    const unsubOccurrences = fileMetadataOccurrencesStore.subscribeBatches(
      (changes) => {
        const startedAt = frontendNow();
        const prepared = changes.map(({ path, value }) => {
          const revision = (occurrenceRevisionsRef.current.get(path) ?? 0) + 1;
          occurrenceRevisionsRef.current.set(path, revision);
          const occurrences =
            value === undefined ? undefined : toSearchOccurrencesState(value);
          return {
            path,
            revision,
            occurrences,
            ids:
              occurrences === undefined ? [] : idsFromOccurrences(occurrences),
          };
        });
        const ids = prepared.flatMap((entry) => entry.ids);
        void resolveTagInfosExact(ids)
          .then((resolved) => {
            if (!isCurrentWorker()) return;
            const current = prepared.filter(
              ({ path, revision }) =>
                occurrenceRevisionsRef.current.get(path) === revision,
            );
            if (current.length === 0) return;
            w.postMessage({
              type: "UPSERT_OCCURRENCES_BATCH",
              entries: current.flatMap(({ path, occurrences }) =>
                occurrences === undefined ? [] : [{ path, occurrences }],
              ),
              deletedPaths: current.flatMap(({ path, occurrences }) =>
                occurrences === undefined ? [path] : [],
              ),
              schemaLabels: labelsFromResolved(ids, resolved),
            });
            refreshCurrentQuery();
          })
          .catch(() => {
            // A later update retries.
          })
          .finally(() => {
            logSlowFrontendOperation("search-occurrence-refresh", startedAt, {
              files: changes.length,
            });
          });
      },
    );
    const unsubDrafts = targetDraftEditsStore.subscribe((changes) => {
      const startedAt = frontendNow();
      const prepared = changes.map((c) => {
        const revision = (draftRevisionsRef.current.get(c.path) ?? 0) + 1;
        draftRevisionsRef.current.set(c.path, revision);
        const edits = toSearchDraftEntries(c.edits);
        const ids = edits?.map(({ id }) => id) ?? [];
        return { path: c.path, revision, edits, ids };
      });
      const ids = prepared.flatMap((entry) => entry.ids);
      void resolveTagInfosExact(ids)
        .then((resolved) => {
          if (!isCurrentWorker()) return;
          const entries = prepared
            .filter(
              ({ path, revision }) =>
                draftRevisionsRef.current.get(path) === revision,
            )
            .map(({ path, edits }) => ({ path, edits }));
          if (entries.length === 0) return;
          w.postMessage({
            type: "UPSERT_DRAFTS_BATCH",
            entries,
            schemaLabels: labelsFromResolved(ids, resolved),
          });
          refreshCurrentQuery();
        })
        .catch(() => {
          // A later update retries.
        })
        .finally(() => {
          logSlowFrontendOperation("search-draft-refresh", startedAt, {
            files: changes.length,
          });
        });
    });
    return () => {
      active = false;
      if (initialReplayRetryTimer) {
        clearTimeout(initialReplayRetryTimer);
        initialReplayRetryTimer = null;
      }
      unsubOccurrences();
      unsubDrafts();
    };
  }, [
    fileMetadataOccurrencesStore,
    refreshCurrentQuery,
    targetDraftEditsStore,
  ]);

  // ── File list sync + re-submit ─────────────────────────────────────
  useEffect(() => {
    const w = workerRef.current;
    if (!w) {
      prevFilesRef.current = files;
      return;
    }
    const { upserts, deletions } = diffFilePaths(prevFilesRef.current, files);
    prevFilesRef.current = files;
    if (upserts.length === 0 && deletions.length === 0) return;
    for (const p of upserts) {
      w.postMessage({ type: "UPSERT_PHOTO", file: fileToFields(p) });
    }
    for (const path of deletions) {
      w.postMessage({ type: "DELETE_PATH", path });
    }
    // Re-submit current query so the user sees results refresh (and the
    // pending indicator) when files arrive mid-search.
    refreshCurrentQuery();
  }, [files, refreshCurrentQuery]);

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
  }, [query, debounceMs, submitNow]);

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

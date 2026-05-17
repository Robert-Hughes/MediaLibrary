import { useEffect, useRef, useState } from "react";
import type { DraftEditsStore, ImageMetadataStore, PhotoInfo } from "../types";
import type {
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "../workers/searchWorkerProtocol";

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

function diffPhotoPaths(prev: PhotoInfo[], next: PhotoInfo[]): {
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
      !before
      || before.filename !== p.filename
      || before.date_modified !== p.date_modified
      || before.date_created !== p.date_created
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
export function useSearchWorker(args: UseSearchWorkerArgs): UseSearchWorkerResult {
  const { photos, imageMetadataStore, draftEditsStore, query, debounceMs = 150, createWorker } = args;

  const workerRef = useRef<SearchWorkerLike | null>(null);
  const reqIdRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;
  const prevPhotosRef = useRef<PhotoInfo[]>([]);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    };
    // createWorker is intended to be stable (defined once in the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Subscribe to metadata store + cold-start replay ─────────────────
  useEffect(() => {
    const w = workerRef.current;
    if (!w) return;
    // Reset and replay the current store contents.  Scan reset swaps in a
    // fresh store instance, which is what re-runs this effect.
    w.postMessage({ type: "CLEAR" });
    w.postMessage({
      type: "INIT_PHOTOS",
      photos: prevPhotosRef.current.map(photoToFields),
    });
    w.postMessage({
      type: "INIT_META",
      entries: Array.from(imageMetadataStore.entries()).map(([path, meta]) => ({ path, meta })),
    });
    w.postMessage({
      type: "INIT_DRAFTS",
      entries: Object.entries(draftEditsStore.getAll()).map(([path, edits]) => ({ path, edits })),
    });
    submitNow(queryRef.current);

    const unsubMeta = imageMetadataStore.subscribeAll((path, meta) => {
      w.postMessage({ type: "UPSERT_META", path, meta });
      submitNow(queryRef.current);
    });
    const unsubDrafts = draftEditsStore.subscribe((changes) => {
      for (const c of changes) {
        w.postMessage({ type: "UPSERT_DRAFTS", path: c.path, edits: c.edits });
      }
      submitNow(queryRef.current);
    });
    return () => {
      unsubMeta();
      unsubDrafts();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageMetadataStore, draftEditsStore]);

  // ── Photo list sync + re-submit ─────────────────────────────────────
  useEffect(() => {
    const w = workerRef.current;
    if (!w) {
      prevPhotosRef.current = photos;
      return;
    }
    const { upserts, deletions } = diffPhotoPaths(prevPhotosRef.current, photos);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

import type {
  MediaLibrarySessionFileThumbnail,
  MediaLibraryThumbnailPayload,
  ThumbnailStore,
} from "./types";
import { yieldToBrowser } from "./utils/yieldToBrowser";

// Also bounds recovery snapshots, which may include the entire library.
const THUMBNAIL_REQUEST_BATCH_SIZE = 50;

export interface SessionThumbnailProjectionDependencies {
  store: ThumbnailStore;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  isCurrentSession: (sessionId: number) => boolean;
  canInstall?: (relativePath: string, cacheKey: string) => boolean;
}

export async function projectSessionThumbnails(
  sessionId: number,
  entries: readonly MediaLibrarySessionFileThumbnail[],
  dependencies: SessionThumbnailProjectionDependencies,
): Promise<void> {
  const ready = new Map<string, string>();
  for (const entry of entries) {
    if (
      entry.state.status === "ready" &&
      dependencies.canInstall?.(entry.relative_path, entry.state.cache_key) ===
        false
    )
      continue;
    dependencies.store.add(entry.relative_path);
    if (entry.state.status === "loading") continue;
    if (entry.state.status === "failed") {
      dependencies.store.set(entry.relative_path, "failed");
      continue;
    }
    dependencies.store.set(entry.relative_path, "loading");
    ready.set(entry.state.cache_key, entry.relative_path);
  }
  if (ready.size === 0) return;

  const cacheKeys = [...ready.keys()];
  for (
    let offset = 0;
    offset < cacheKeys.length;
    offset += THUMBNAIL_REQUEST_BATCH_SIZE
  ) {
    const chunk = cacheKeys.slice(
      offset,
      offset + THUMBNAIL_REQUEST_BATCH_SIZE,
    );
    const payloads = (await dependencies.invoke(
      "get_media_library_thumbnails",
      {
        sessionId,
        cacheKeys: chunk,
      },
    )) as MediaLibraryThumbnailPayload[];
    if (!dependencies.isCurrentSession(sessionId)) return;

    const requested = new Set(chunk);
    const received = new Set<string>();
    for (const payload of payloads) {
      if (!requested.has(payload.cache_key)) continue;
      const relativePath = ready.get(payload.cache_key)!;
      if (dependencies.canInstall?.(relativePath, payload.cache_key) === false)
        continue;
      received.add(payload.cache_key);
      dependencies.store.set(relativePath, payload.thumbnail);
    }
    for (const cacheKey of chunk) {
      if (dependencies.canInstall?.(ready.get(cacheKey)!, cacheKey) === false)
        continue;
      if (!received.has(cacheKey))
        dependencies.store.set(ready.get(cacheKey)!, "failed");
    }
  }
}

/** Download disposable image payloads independently of ordered session updates.
 * Keep one request in flight and coalesce replaced per-file versions.
 */
export function createSessionThumbnailProjector(
  dependencies: SessionThumbnailProjectionDependencies & {
    onError: (error: unknown) => void;
    yieldToBrowser?: () => Promise<void>;
    onBatch?: (batch: {
      sessionId: number;
      entries: number;
      durationMs: number;
      pendingEntries: number;
    }) => void;
  },
) {
  let sessionId: number | null = null;
  const pending = new Map<string, MediaLibrarySessionFileThumbnail>();
  const versions = new Map<string, string>();
  let running = false;

  const reset = () => {
    sessionId = null;
    pending.clear();
    versions.clear();
  };

  const drain = async () => {
    if (running) return;
    running = true;
    try {
      while (pending.size > 0) {
        const requestSession = sessionId!;
        const entries: MediaLibrarySessionFileThumbnail[] = [];
        for (const entry of pending.values()) {
          entries.push(entry);
          if (entries.length === THUMBNAIL_REQUEST_BATCH_SIZE) break;
        }
        for (const entry of entries) pending.delete(entry.relative_path);
        const isCurrentSession = (id: number) =>
          sessionId === id && dependencies.isCurrentSession(id);
        if (!isCurrentSession(requestSession)) {
          reset();
          break;
        }
        const started = Date.now();
        try {
          await projectSessionThumbnails(requestSession, entries, {
            ...dependencies,
            isCurrentSession,
            canInstall: (path, key) => versions.get(path) === key,
          });
        } catch (error) {
          if (isCurrentSession(requestSession)) {
            for (const entry of entries) {
              if (
                entry.state.status === "ready" &&
                versions.get(entry.relative_path) === entry.state.cache_key
              ) {
                dependencies.store.set(entry.relative_path, "failed");
              }
            }
            dependencies.onError(error);
          }
        }
        dependencies.onBatch?.({
          sessionId: requestSession,
          entries: entries.length,
          durationMs: Date.now() - started,
          pendingEntries: pending.size,
        });
        if (pending.size > 0) {
          await (dependencies.yieldToBrowser ?? yieldToBrowser)();
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    reset,
    project: (
      id: number,
      entries: readonly MediaLibrarySessionFileThumbnail[],
    ) => {
      if (!dependencies.isCurrentSession(id)) return;
      if (sessionId !== id) {
        reset();
        sessionId = id;
      }
      for (const entry of entries) {
        dependencies.store.add(entry.relative_path);
        pending.delete(entry.relative_path);
        if (entry.state.status === "ready") {
          versions.set(entry.relative_path, entry.state.cache_key);
          dependencies.store.set(entry.relative_path, "loading");
          pending.set(entry.relative_path, entry);
        } else {
          versions.delete(entry.relative_path);
          dependencies.store.set(entry.relative_path, entry.state.status);
        }
      }
      void drain().catch(dependencies.onError);
    },
  };
}

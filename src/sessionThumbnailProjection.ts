import type {
  MediaLibrarySessionFileThumbnail,
  MediaLibraryThumbnailPayload,
  ThumbnailStore,
} from "./types";

export interface SessionThumbnailProjectionDependencies {
  store: ThumbnailStore;
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  isCurrentSession: (sessionId: number) => boolean;
}

export async function projectSessionThumbnails(
  sessionId: number,
  entries: readonly MediaLibrarySessionFileThumbnail[],
  dependencies: SessionThumbnailProjectionDependencies,
): Promise<void> {
  const ready = new Map<string, string>();
  for (const entry of entries) {
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

  const payloads = (await dependencies.invoke("get_media_library_thumbnails", {
    sessionId,
    cacheKeys: [...ready.keys()],
  })) as MediaLibraryThumbnailPayload[];
  if (!dependencies.isCurrentSession(sessionId)) return;

  const received = new Set<string>();
  for (const payload of payloads) {
    const relativePath = ready.get(payload.cache_key);
    if (!relativePath) continue;
    received.add(payload.cache_key);
    dependencies.store.set(relativePath, payload.thumbnail);
  }
  for (const [cacheKey, relativePath] of ready) {
    if (!received.has(cacheKey)) dependencies.store.set(relativePath, "failed");
  }
}

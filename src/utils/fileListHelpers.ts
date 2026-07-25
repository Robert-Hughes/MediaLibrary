/**
 * Return the visible paths that still need a thumbnail or metadata load,
 * in the iteration order of `visible` (which matches display top-to-bottom).
 *
 * Iterates `visible` directly — O(V), not O(total files) — so a 30-row
 * scroll on a 10k-file library doesn't scan the full list.
 */
export function selectVisibleNeedingLoad(
  visible: Iterable<string>,
  thumbnails: { get: (path: string) => unknown },
  imageMetadata: { get: (path: string) => unknown },
): string[] {
  const out: string[] = [];
  for (const path of visible) {
    if (
      thumbnails.get(path) === "loading" ||
      imageMetadata.get(path) === "loading"
    ) {
      out.push(path);
    }
  }
  return out;
}

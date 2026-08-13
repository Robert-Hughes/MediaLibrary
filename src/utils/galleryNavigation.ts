import type { FileInfo } from "../types";

/** Keep the gallery open after removing its current item when a neighbour remains. */
export function galleryPathAfterRemoval(
  files: readonly FileInfo[],
  currentIndex: number,
): string | null {
  return (
    files[currentIndex + 1]?.relative_path ??
    files[currentIndex - 1]?.relative_path ??
    null
  );
}

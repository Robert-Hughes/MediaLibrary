import type { FileInfo } from "../types";

/**
 * Return true only when every requested path resolves to a stored image file.
 * Missing paths fail closed so callers cannot accidentally bypass media gating.
 */
export function arePathsImageOnly(
  files: readonly FileInfo[],
  relativePaths: readonly string[],
): boolean {
  if (relativePaths.length === 0) return false;
  const filesByPath = new Map(files.map((file) => [file.relative_path, file]));
  return relativePaths.every(
    (path) => filesByPath.get(path)?.media_kind === "image",
  );
}

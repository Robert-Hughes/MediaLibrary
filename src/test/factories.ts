/**
 * Test factory helpers for creating minimal PhotoInfo objects.
 * Fills in all required fields with sensible defaults so tests only
 * need to specify the fields they care about.
 */
import type { PhotoInfo } from "../types";

export function makePhoto(overrides: Partial<PhotoInfo> & { relative_path: string }): PhotoInfo {
  return {
    filename: overrides.relative_path.split("/").pop() ?? overrides.relative_path,
    date_modified: null,
    date_created: null,
    date_taken: null,
    camera_model: null,
    ...overrides,
  };
}

export function makePhotos(paths: string[]): PhotoInfo[] {
  return paths.map((p) => makePhoto({ relative_path: p }));
}

import type { PhotoInfo } from "../types";

export function makePhoto(overrides: Partial<PhotoInfo> & { relative_path: string }): PhotoInfo {
  return {
    filename: overrides.relative_path.split("/").pop() ?? overrides.relative_path,
    date_modified: null,
    date_created: null,
    ...overrides,
  };
}

export function makePhotos(paths: string[]): PhotoInfo[] {
  return paths.map((p) => makePhoto({ relative_path: p }));
}

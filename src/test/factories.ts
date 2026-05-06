import type { PhotoInfo } from "../types";

export function makePhoto(overrides: Partial<PhotoInfo> = {}): PhotoInfo {
  const relative_path = overrides.relative_path ?? "photo.jpg";
  return {
    relative_path,
    filename: relative_path.split("/").pop() ?? relative_path,
    date_modified: null,
    date_created: null,
    ...overrides,
  };
}

export function makePhotos(paths: string[]): PhotoInfo[] {
  return paths.map((p) => makePhoto({ relative_path: p }));
}

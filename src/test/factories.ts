import type { PhotoInfo, VisibleColumn } from "../types";

export const osCol = (key: string): VisibleColumn => ({ key, kind: "os" });
export const imgCol = (key: string): VisibleColumn => ({ key, kind: "image" });

export function makeColumns(items: Array<string | VisibleColumn>, defaultKind: "os" | "image" = "image"): VisibleColumn[] {
  return items.map((it) =>
    typeof it === "string" ? { key: it, kind: defaultKind } : it,
  );
}

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

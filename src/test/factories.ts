import type { PhotoInfo, VisibleColumn, MetadataValue } from "../types";

export const osCol = (key: string): VisibleColumn => ({ key, kind: "os" });
export const imgCol = (key: string): VisibleColumn => ({ key, kind: "image" });

export function makeColumns(
  items: Array<string | VisibleColumn>,
  defaultKind: "os" | "image" = "image",
): VisibleColumn[] {
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

export function mockMetadata(
  raw: Record<string, unknown>,
): Record<string, MetadataValue> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      testValueToMetadataValue(value),
    ]),
  );
}

function testValueToMetadataValue(value: unknown): MetadataValue {
  if (isMetadataValue(value)) return value;
  if (value === null || value === undefined) return { kind: "Null" };
  if (typeof value === "string") return { kind: "Text", value };
  if (typeof value === "boolean") return { kind: "Bool", value };
  if (typeof value === "number") return { kind: "Real", value };
  if (Array.isArray(value)) {
    return {
      kind: "List",
      value: {
        list_kind: "Unknown",
        items: value.map(testValueToMetadataValue),
      },
    };
  }
  return {
    kind: "Struct",
    value: Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        testValueToMetadataValue(child),
      ]),
    ),
  };
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

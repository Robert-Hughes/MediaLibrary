import type {
  ImageMetadataEntry,
  MetadataDraftCollection,
  MetadataDraftEdit,
  MetadataDraftEditsByFile,
  MetadataOccurrence,
  MetadataValue,
  EditIntent,
  OsColumnKey,
  PhotoInfo,
  SchemaDefinitionId,
  SortDirection,
  SortKey,
  VisibleColumn,
} from "../types";
import type { MetadataCollection } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
import { testFriendlyName, testId } from "./testIds";
import { _ensureTagInfoCacheEntry } from "../hooks/useTagInfo";

export { testFriendlyName, testId };

export const osCol = (key: OsColumnKey): VisibleColumn => ({ kind: "os", key });
export const imgCol = (id: SchemaDefinitionId | string): VisibleColumn => {
  const exactId = typeof id === "string" ? fixtureId(id) : id;
  return { kind: "image", id: exactId };
};

export function makeColumns(
  items: Array<string | VisibleColumn>,
  defaultKind: "os" | "image" = "image",
): VisibleColumn[] {
  return items.map((item) => {
    if (typeof item !== "string") return item;
    return defaultKind === "os" ? osCol(item as OsColumnKey) : imgCol(item);
  });
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

export function mockMetadata(raw: Record<string, unknown>): MetadataCollection {
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => {
      const id = fixtureId(name);
      const metadataValue = testValueToMetadataValue(value);
      return [
        schemaDefinitionIdToken(id),
        { ...metadataValue, id } as ImageMetadataEntry,
      ];
    }),
  );
}

export function mockOccurrences(
  raw: Record<string, unknown>,
): MetadataOccurrence[] {
  return occurrencesFromMetadataCollection(mockMetadata(raw));
}

export function mockDrafts(
  raw: Record<string, MetadataDraftEdit | unknown>,
): MetadataDraftCollection {
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => {
      const id = fixtureId(name);
      const edit = isMetadataDraftEdit(value)
        ? value
        : fixtureValueToDraftEdit(value);
      return [schemaDefinitionIdToken(id), { id, edit }];
    }),
  );
}

export function mockDraftsByFile(
  raw: Record<string, Record<string, MetadataDraftEdit | unknown>>,
): MetadataDraftEditsByFile {
  return Object.fromEntries(
    Object.entries(raw).map(([path, drafts]) => [path, mockDrafts(drafts)]),
  );
}

export function mockDisplayDrafts(
  raw: Record<string, string | null>,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(raw).map(([name, value]) => [
      schemaDefinitionIdToken(testId(name)),
      value,
    ]),
  );
}

export const imageSort = (
  idOrName: SchemaDefinitionId | string,
  direction: SortDirection,
): SortKey => ({
  kind: "image",
  id: typeof idOrName === "string" ? testId(idOrName) : idOrName,
  direction,
});

export const osSort = (
  key: OsColumnKey,
  direction: SortDirection,
): SortKey => ({
  kind: "os",
  key,
  direction,
});

export const pathSort = (direction: SortDirection): SortKey => ({
  kind: "path",
  direction,
});

function fixtureValueToDraftEdit(value: unknown): MetadataDraftEdit {
  return value === null || value === undefined
    ? { intent: "Delete", value: null }
    : { intent: "Set", value: testValueToMetadataValue(value) };
}

function isMetadataDraftEdit(value: unknown): value is MetadataDraftEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as { intent?: unknown; value?: unknown };
  return isEditIntent(candidate.intent) && "value" in candidate;
}

function isEditIntent(intent: unknown): intent is EditIntent {
  switch (intent) {
    case "Set":
    case "Delete":
    case "ListAdd":
    case "ListRemove":
      return true;
    default:
      return false;
  }
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

function fixtureId(name: string): SchemaDefinitionId {
  const id = testId(name);
  const canonicalName = testFriendlyName(id);
  const colon = canonicalName.indexOf(":");
  _ensureTagInfoCacheEntry(id, {
    id,
    group: colon > 0 ? canonicalName.slice(0, colon) : "Test",
    name: colon > 0 ? canonicalName.slice(colon + 1) : canonicalName,
    writable: true,
    kind: { kind: "Text" },
    description: null,
    storage_count: undefined,
  });
  return id;
}

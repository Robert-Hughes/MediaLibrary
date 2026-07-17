import type {
  ImageMetadataEntry,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

/**
 * Token-keyed, derived read-only schema view. It is never scanner wire data,
 * authoritative occurrence state, or a safe way to select an occurrence.
 */
export type MetadataCollection = Record<string, ImageMetadataEntry>;

export interface SchemaMetadataValueEntry {
  id: SchemaDefinitionId;
  value: MetadataValue;
}

export function metadataCollection(
  entries: readonly SchemaMetadataValueEntry[],
): MetadataCollection {
  return Object.fromEntries(
    entries.map((entry) => [
      schemaDefinitionIdToken(entry.id),
      { ...entry.value, id: entry.id } as ImageMetadataEntry,
    ]),
  );
}

export function metadataGet(
  collection: MetadataCollection,
  id: SchemaDefinitionId,
): ImageMetadataEntry | undefined {
  return collection[schemaDefinitionIdToken(id)];
}

export function metadataHas(
  collection: MetadataCollection,
  id: SchemaDefinitionId,
): boolean {
  return schemaDefinitionIdToken(id) in collection;
}

export function metadataEntries(
  collection: MetadataCollection,
): SchemaMetadataValueEntry[] {
  return Object.values(collection).flatMap((value) =>
    value.id ? [{ id: value.id, value: stripMetadataEntryId(value) }] : [],
  );
}

export function metadataIds(
  collection: MetadataCollection,
): SchemaDefinitionId[] {
  return Object.values(collection).flatMap((entry) =>
    entry.id ? [entry.id] : [],
  );
}

function stripMetadataEntryId(entry: ImageMetadataEntry): MetadataValue {
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

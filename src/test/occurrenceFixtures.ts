import type {
  FileMetadataEntry,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import { FileMetadataOccurrencesStore } from "../types";
import type { MetadataCollection } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { testFriendlyName } from "./testIds";

export function kindForValue(value: MetadataValue): TagKind {
  switch (value.kind) {
    case "Text":
      return { kind: "Text" };
    case "Integer":
      return { kind: "Integer", data: { min: null, max: null } };
    case "Real":
      return { kind: "Real" };
    case "Rational":
      return { kind: "Rational" };
    case "Bool":
      return { kind: "Boolean" };
    case "Date":
      return { kind: "Date" };
    case "Time":
      return { kind: "Time" };
    case "DateTime":
      return { kind: "DateTime" };
    case "TimeOffset":
      return { kind: "TimeOffset" };
    case "LangAlt":
      return { kind: "LangAlt" };
    case "List":
      return { kind: "Bag", data: { kind: "Text" } };
    case "Struct":
      return { kind: "Struct", data: {} };
    case "Binary":
      return { kind: "Binary" };
    case "Unknown":
      return value.value.expected ?? { kind: "Text" };
    case "Null":
      return { kind: "Text" };
  }
}

function infoFor(id: SchemaDefinitionId, value: MetadataValue): TagInfo {
  const friendly = testFriendlyName(id);
  const colon = friendly.indexOf(":");
  return {
    id: structuredClone(id),
    group0: id.table.startsWith("XMP::")
      ? "XMP"
      : id.table.startsWith("IPTC::")
        ? "IPTC"
        : "EXIF",
    group: colon > 0 ? friendly.slice(0, colon) : "Test",
    name: colon > 0 ? friendly.slice(colon + 1) : friendly,
    writable: true,
    kind: kindForValue(value),
    description: null,
    storage_count: undefined,
  };
}

export function occurrenceFromSchemaValue(
  id: SchemaDefinitionId,
  value: MetadataValue,
  ordinal = 0,
): MetadataOccurrence {
  const info = infoFor(id, value);
  return {
    id: {
      document: null,
      path: `TestFixture-${ordinal}`,
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: ordinal,
    },
    schema_id: structuredClone(id),
    value: structuredClone(value),
    tag_info: info,
    observed_selector: {
      group1: info.group,
      group7: "ID-Test",
      tag_name: info.name,
    },
    write_target: {
      group1: info.group,
      group7: "ID-Test",
      tag_name: info.name,
    },
  };
}

export function occurrencesFromMetadataCollection(
  metadata: MetadataCollection,
): MetadataOccurrence[] {
  return Object.values(metadata)
    .sort((left, right) =>
      schemaDefinitionIdToken(left.id).localeCompare(
        schemaDefinitionIdToken(right.id),
      ),
    )
    .map((entry: FileMetadataEntry, ordinal) => {
      const { id, ...value } = entry;
      return occurrenceFromSchemaValue(id, value as MetadataValue, ordinal);
    });
}

export function occurrenceStore(
  byPath: Record<string, MetadataCollection | MetadataOccurrence[]> = {},
): FileMetadataOccurrencesStore {
  const store = new FileMetadataOccurrencesStore();
  for (const [path, value] of Object.entries(byPath)) {
    store.set(
      path,
      Array.isArray(value)
        ? structuredClone(value)
        : occurrencesFromMetadataCollection(value),
    );
  }
  return store;
}

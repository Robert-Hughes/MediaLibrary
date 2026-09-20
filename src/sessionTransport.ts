import type {
  MediaLibrarySessionMetadataChanged,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataObservedSelector,
  MetadataValue,
  MetadataWriteTarget,
  SchemaDefinitionId,
} from "./types";

export const METADATA_DICTIONARY_FORMAT =
  "media-library-metadata-dictionary-v2";

interface MetadataOccurrenceDictionariesWire {
  ids: MetadataOccurrenceId[];
  schema_ids: SchemaDefinitionId[];
  values: MetadataValue[];
  observed_selectors: Array<MetadataObservedSelector | null>;
  write_targets: Array<MetadataWriteTarget | null>;
}

type MetadataDictionaryStateWire =
  | { status: "loading" }
  | { status: "failed"; error: string }
  | { status: "ready"; occurrences: number[][] };

interface MetadataDictionaryDeltaWire {
  format: string;
  session_id: number;
  revision: number;
  dictionaries: MetadataOccurrenceDictionariesWire;
  entries: Array<{
    relative_path: string;
    state: MetadataDictionaryStateWire;
  }>;
}

function metadataDictionaryDeltaFromUnknown(
  payload: unknown,
): MetadataDictionaryDeltaWire {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("Metadata dictionary payload is not an object");
  }
  const wire = payload as Partial<MetadataDictionaryDeltaWire>;
  if (wire.format !== METADATA_DICTIONARY_FORMAT) {
    throw new Error(
      `Unsupported metadata dictionary format '${String(wire.format)}'`,
    );
  }
  if (
    !wire.dictionaries ||
    !Array.isArray(wire.entries) ||
    typeof wire.session_id !== "number" ||
    typeof wire.revision !== "number"
  ) {
    throw new Error("Metadata dictionary payload is malformed");
  }

  const dictionaries = wire.dictionaries;
  if (
    !Array.isArray(dictionaries.ids) ||
    !Array.isArray(dictionaries.schema_ids) ||
    !Array.isArray(dictionaries.values) ||
    !Array.isArray(dictionaries.observed_selectors) ||
    !Array.isArray(dictionaries.write_targets)
  ) {
    throw new Error("Metadata dictionary tables are malformed");
  }

  return wire as MetadataDictionaryDeltaWire;
}

function dictionaryEntry<T>(
  dictionary: readonly T[],
  index: number,
  name: string,
): T {
  if (!Number.isInteger(index) || index < 0 || index >= dictionary.length) {
    throw new Error(`Invalid ${name} dictionary index ${String(index)}`);
  }
  return dictionary[index]!;
}

export function decodeMetadataDictionaryDelta(
  payload: unknown,
): MediaLibrarySessionMetadataChanged {
  const wire = metadataDictionaryDeltaFromUnknown(payload);
  const dictionaries = wire.dictionaries;

  return {
    session_id: wire.session_id,
    revision: wire.revision,
    entries: wire.entries.map((entry) => {
      if (entry.state.status === "loading") {
        return {
          relative_path: entry.relative_path,
          state: { status: "loading" as const },
        };
      }
      if (entry.state.status === "failed") {
        return {
          relative_path: entry.relative_path,
          state: {
            status: "failed" as const,
            error: entry.state.error,
          },
        };
      }
      if (entry.state.status !== "ready") {
        throw new Error("Unknown metadata dictionary state");
      }

      const occurrences = entry.state.occurrences.map((indexes) => {
        if (!Array.isArray(indexes) || indexes.length !== 5) {
          throw new Error(
            "Metadata occurrence dictionary reference must contain five indexes",
          );
        }
        const occurrence: MetadataOccurrence = {
          id: dictionaryEntry(dictionaries.ids, indexes[0]!, "id"),
          schema_id: dictionaryEntry(
            dictionaries.schema_ids,
            indexes[1]!,
            "schema_id",
          ),
          value: dictionaryEntry(dictionaries.values, indexes[2]!, "value"),
          observed_selector: dictionaryEntry(
            dictionaries.observed_selectors,
            indexes[3]!,
            "observed_selector",
          ),
          write_target: dictionaryEntry(
            dictionaries.write_targets,
            indexes[4]!,
            "write_target",
          ),
        };
        return occurrence;
      });

      return {
        relative_path: entry.relative_path,
        state: { status: "ready" as const, occurrences },
      };
    }),
  };
}

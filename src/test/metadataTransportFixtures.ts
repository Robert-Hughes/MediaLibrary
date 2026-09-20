import type {
  MediaLibrarySessionMetadataChanged,
  MetadataOccurrences,
} from "../types";
import { METADATA_DICTIONARY_FORMAT } from "../sessionTransport";

export function compactMetadataDeltaForTest(
  delta: MediaLibrarySessionMetadataChanged,
): unknown {
  const dictionaries = {
    ids: [] as Array<MetadataOccurrences[number]["id"]>,
    schema_ids: [] as Array<MetadataOccurrences[number]["schema_id"]>,
    values: [] as Array<MetadataOccurrences[number]["value"]>,
    observed_selectors: [] as Array<
      MetadataOccurrences[number]["observed_selector"]
    >,
    write_targets: [] as Array<MetadataOccurrences[number]["write_target"]>,
  };
  const indexes = {
    ids: new Map<string, number>(),
    schema_ids: new Map<string, number>(),
    values: new Map<string, number>(),
    observed_selectors: new Map<string, number>(),
    write_targets: new Map<string, number>(),
  };

  const intern = <T>(
    values: T[],
    byJson: Map<string, number>,
    value: T,
  ): number => {
    const key = JSON.stringify(value);
    const existing = byJson.get(key);
    if (existing !== undefined) return existing;
    const index = values.length;
    values.push(value);
    byJson.set(key, index);
    return index;
  };

  return {
    format: METADATA_DICTIONARY_FORMAT,
    session_id: delta.session_id,
    revision: delta.revision,
    dictionaries,
    entries: delta.entries.map((entry) => {
      if (entry.state.status !== "ready") return entry;
      return {
        relative_path: entry.relative_path,
        state: {
          status: "ready",
          occurrences: entry.state.occurrences.map((occurrence) => [
            intern(dictionaries.ids, indexes.ids, occurrence.id),
            intern(
              dictionaries.schema_ids,
              indexes.schema_ids,
              occurrence.schema_id,
            ),
            intern(dictionaries.values, indexes.values, occurrence.value),
            intern(
              dictionaries.observed_selectors,
              indexes.observed_selectors,
              occurrence.observed_selector,
            ),
            intern(
              dictionaries.write_targets,
              indexes.write_targets,
              occurrence.write_target,
            ),
          ]),
        },
      };
    }),
  };
}

import type { MetadataOccurrence, SchemaDefinitionId } from "../types";
import { compareMetadataOccurrenceIds } from "./metadataOccurrenceId";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";

export type SchemaOccurrenceResolution =
  | { kind: "missing" }
  | { kind: "unique"; occurrence: MetadataOccurrence }
  | { kind: "multiple"; occurrences: MetadataOccurrence[] };

export type SchemaOccurrenceResolutionIndex = ReadonlyMap<
  string,
  SchemaOccurrenceResolution
>;

const MISSING_RESOLUTION: SchemaOccurrenceResolution = { kind: "missing" };

function resolutionFromMatches(
  matches: readonly MetadataOccurrence[],
): SchemaOccurrenceResolution {
  if (matches.length === 0) return MISSING_RESOLUTION;
  if (matches.length === 1) return { kind: "unique", occurrence: matches[0] };
  return {
    kind: "multiple",
    occurrences: [...matches].sort((a, b) =>
      compareMetadataOccurrenceIds(a.id, b.id),
    ),
  };
}

export function resolveOccurrencesForSchema(
  occurrences: readonly MetadataOccurrence[],
  schemaId: SchemaDefinitionId,
): SchemaOccurrenceResolution {
  return resolutionFromMatches(
    occurrences.filter(
      (occurrence) =>
        occurrence.tag_info !== null &&
        schemaDefinitionIdEquals(occurrence.tag_info.id, schemaId),
    ),
  );
}

export function buildSchemaOccurrenceResolutionIndex(
  occurrences: readonly MetadataOccurrence[],
): SchemaOccurrenceResolutionIndex {
  const grouped = new Map<string, MetadataOccurrence[]>();
  for (const occurrence of occurrences) {
    if (occurrence.tag_info === null) continue;
    const token = schemaDefinitionIdToken(occurrence.tag_info.id);
    const matches = grouped.get(token);
    if (matches) matches.push(occurrence);
    else grouped.set(token, [occurrence]);
  }

  const index = new Map<string, SchemaOccurrenceResolution>();
  for (const token of [...grouped.keys()].sort()) {
    index.set(token, resolutionFromMatches(grouped.get(token)!));
  }
  return index;
}

export function resolutionForSchema(
  index: SchemaOccurrenceResolutionIndex,
  schemaId: SchemaDefinitionId,
): SchemaOccurrenceResolution {
  return index.get(schemaDefinitionIdToken(schemaId)) ?? MISSING_RESOLUTION;
}

import type {
  MetadataOccurrence,
  MetadataOccurrenceId,
  SchemaDefinitionId,
} from "../types";
import {
  compareMetadataOccurrenceIds,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
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

export interface DuplicateMetadataOccurrenceId {
  occurrenceId: MetadataOccurrenceId;
  occurrences: MetadataOccurrence[];
}

/** Finds the first duplicate complete runtime occurrence ID, independent of schema. */
export function findDuplicateMetadataOccurrenceId(
  occurrences: readonly MetadataOccurrence[],
): DuplicateMetadataOccurrenceId | null {
  const grouped = new Map<string, MetadataOccurrence[]>();
  for (const occurrence of occurrences) {
    const token = metadataOccurrenceIdToken(occurrence.id);
    const matches = grouped.get(token);
    if (matches) matches.push(occurrence);
    else grouped.set(token, [occurrence]);
  }
  for (const matches of grouped.values()) {
    if (matches.length > 1) {
      return {
        occurrenceId: structuredClone(matches[0].id),
        occurrences: structuredClone(matches),
      };
    }
  }
  return null;
}
export type ExactOccurrenceResolution =
  | { kind: "missing" }
  | { kind: "unique"; occurrence: MetadataOccurrence }
  | { kind: "duplicate"; occurrences: MetadataOccurrence[] };

/** Resolve one runtime ID exactly; duplicate IDs are rejected, never selected. */
export function resolveExactMetadataOccurrence(
  occurrences: readonly MetadataOccurrence[],
  occurrenceId: MetadataOccurrenceId,
): ExactOccurrenceResolution {
  const expected = metadataOccurrenceIdToken(occurrenceId);
  const matches = occurrences.filter(
    (occurrence) => metadataOccurrenceIdToken(occurrence.id) === expected,
  );
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length === 1) return { kind: "unique", occurrence: matches[0] };
  return { kind: "duplicate", occurrences: matches };
}

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
    occurrences.filter((occurrence) =>
      schemaDefinitionIdEquals(occurrence.schema_id, schemaId),
    ),
  );
}

export function buildSchemaOccurrenceResolutionIndex(
  occurrences: readonly MetadataOccurrence[],
): SchemaOccurrenceResolutionIndex {
  const grouped = new Map<string, MetadataOccurrence[]>();
  for (const occurrence of occurrences) {
    const token = schemaDefinitionIdToken(occurrence.schema_id);
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

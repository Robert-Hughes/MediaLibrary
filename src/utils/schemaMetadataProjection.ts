import type {
  ImageMetadataEntry,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataValue,
  SchemaDefinitionId,
} from "../types";
import type { MetadataCollection } from "./metadataCollection";
import {
  compareMetadataOccurrenceIds,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

export type SchemaValueResolution =
  | { kind: "missing" }
  | {
      kind: "value";
      id: SchemaDefinitionId;
      value: MetadataValue;
      occurrenceIds: MetadataOccurrenceId[];
      source: "single" | "identical" | "lang-alt";
    }
  | {
      kind: "ambiguous";
      id: SchemaDefinitionId;
      occurrenceIds: MetadataOccurrenceId[];
      reason: string;
    };

export type SchemaValueResolutionIndex = Map<string, SchemaValueResolution>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function canonicalWireValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalWireValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalWireValue(entry)]),
    );
  }
  return value;
}

function wireStructurallyEqual(
  left: MetadataValue,
  right: MetadataValue,
): boolean {
  return (
    JSON.stringify(canonicalWireValue(left)) ===
    JSON.stringify(canonicalWireValue(right))
  );
}

function sortedOccurrenceIds(
  occurrences: readonly MetadataOccurrence[],
): MetadataOccurrenceId[] {
  return occurrences
    .map((occurrence) => clone(occurrence.id))
    .sort(compareMetadataOccurrenceIds);
}

function ambiguous(
  id: SchemaDefinitionId,
  occurrences: readonly MetadataOccurrence[],
  reason: string,
): SchemaValueResolution {
  return {
    kind: "ambiguous",
    id: clone(id),
    occurrenceIds: sortedOccurrenceIds(occurrences),
    reason,
  };
}

function resolveGroup(
  id: SchemaDefinitionId,
  input: readonly MetadataOccurrence[],
): SchemaValueResolution {
  const occurrences = [...input].sort((left, right) =>
    compareMetadataOccurrenceIds(left.id, right.id),
  );
  const occurrenceIds = sortedOccurrenceIds(occurrences);
  const langAltCount = occurrences.filter(
    (occurrence) => occurrence.value.kind === "LangAlt",
  ).length;

  if (langAltCount > 0 && langAltCount !== occurrences.length) {
    return ambiguous(
      id,
      occurrences,
      "Schema occurrences mix ordinary and LangAlt values.",
    );
  }

  if (langAltCount === occurrences.length) {
    const merged = new Map<string, string>();
    for (const occurrence of occurrences) {
      if (occurrence.value.kind !== "LangAlt") {
        throw new Error("LangAlt group invariant violated");
      }
      for (const [language, text] of Object.entries(
        occurrence.value.value,
      ).sort(([left], [right]) => left.localeCompare(right))) {
        if (text === undefined) continue;
        const existing = merged.get(language);
        if (existing !== undefined && existing !== text) {
          return ambiguous(
            id,
            occurrences,
            `LangAlt language '${language}' has conflicting text.`,
          );
        }
        merged.set(language, text);
      }
    }
    return {
      kind: "value",
      id: clone(id),
      value: {
        kind: "LangAlt",
        value: Object.fromEntries(
          [...merged.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      },
      occurrenceIds,
      source: "lang-alt",
    };
  }

  const first = occurrences[0];
  if (!first) return { kind: "missing" };
  if (
    occurrences.length > 1 &&
    occurrences.some(
      (occurrence) => !wireStructurallyEqual(first.value, occurrence.value),
    )
  ) {
    return ambiguous(
      id,
      occurrences,
      "Schema occurrences contain different wire values.",
    );
  }

  return {
    kind: "value",
    id: clone(id),
    value: clone(first.value),
    occurrenceIds,
    source: occurrences.length === 1 ? "single" : "identical",
  };
}

/**
 * Build a deterministic read-only schema view from authoritative occurrences.
 * The result is presentation data only and must never be used to select a
 * concrete occurrence or retained as a second metadata store.
 */
export function buildSchemaValueResolutionIndex(
  occurrences: readonly MetadataOccurrence[],
): SchemaValueResolutionIndex {
  const groups = new Map<string, MetadataOccurrence[]>();
  const ids = new Map<string, SchemaDefinitionId>();
  for (const occurrence of occurrences) {
    const token = schemaDefinitionIdToken(occurrence.schema_id);
    const group = groups.get(token);
    if (group) group.push(occurrence);
    else groups.set(token, [occurrence]);
    ids.set(token, occurrence.schema_id);
  }

  return new Map(
    [...groups.keys()]
      .sort()
      .map((token) => [
        token,
        resolveGroup(ids.get(token)!, groups.get(token)!),
      ]),
  );
}

export function resolveSchemaValue(
  occurrences: readonly MetadataOccurrence[],
  id: SchemaDefinitionId,
): SchemaValueResolution {
  return (
    buildSchemaValueResolutionIndex(occurrences).get(
      schemaDefinitionIdToken(id),
    ) ?? { kind: "missing" }
  );
}

/** Build the token-keyed safe-value collection used by schema-oriented UI. */
export function schemaMetadataCollectionFromOccurrences(
  occurrences: readonly MetadataOccurrence[],
): MetadataCollection {
  const collection: MetadataCollection = {};
  for (const [token, resolution] of buildSchemaValueResolutionIndex(
    occurrences,
  )) {
    if (resolution.kind !== "value") continue;
    collection[token] = {
      ...clone(resolution.value),
      id: clone(resolution.id),
    } as ImageMetadataEntry;
  }
  return collection;
}

/** Exact schema presence, deliberately independent of value representability. */
export function schemaPresenceTokens(
  occurrences: readonly MetadataOccurrence[],
): Set<string> {
  return new Set(
    occurrences.map((occurrence) =>
      schemaDefinitionIdToken(occurrence.schema_id),
    ),
  );
}

/** Stable diagnostics helper used by tests and ambiguity displays. */
export function resolutionOccurrenceTokens(
  resolution: SchemaValueResolution,
): string[] {
  return resolution.kind === "missing"
    ? []
    : resolution.occurrenceIds.map(metadataOccurrenceIdToken);
}

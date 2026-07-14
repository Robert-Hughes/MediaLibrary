import type {
  MetadataDraftCollection,
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "./types";
import type { TargetDraftCollection } from "./targetDraftEdits";
import { schemaDefinitionIdEquals } from "./utils/schemaDefinitionId";
import type { SchemaOccurrenceResolution } from "./utils/metadataOccurrences";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./utils/metadataDraftTarget";

export type ExistingRowDraftResolution =
  | { kind: "none" }
  | { kind: "legacy"; edit: MetadataDraftEdit }
  | { kind: "target"; entry: MetadataDraftEntryV5 }
  | {
      kind: "blocked";
      reason: string;
      conflictingTargets: MetadataDraftEntryV5[];
    };

/**
 * Resolve draft ownership for one compatibility row without ever selecting a
 * target merely because its schema matches.
 */
export function resolveExistingRowDraft(
  schemaId: SchemaDefinitionId,
  occurrenceResolution: SchemaOccurrenceResolution,
  legacyDrafts: MetadataDraftCollection | undefined,
  targetDrafts: TargetDraftCollection | undefined,
): ExistingRowDraftResolution {
  const legacy = Object.values(legacyDrafts ?? {}).find((entry) =>
    schemaDefinitionIdEquals(entry.id, schemaId),
  );
  if (legacy) return { kind: "legacy", edit: legacy.edit };

  const sameSchema = Object.values(targetDrafts ?? {}).filter((entry) =>
    schemaDefinitionIdEquals(entry.target.schema_id, schemaId),
  );
  if (sameSchema.length === 0) return { kind: "none" };
  if (sameSchema.length > 1) {
    return {
      kind: "blocked",
      reason: "Multiple target-aware operations own this exact schema.",
      conflictingTargets: sameSchema,
    };
  }

  const entry = sameSchema[0];
  if (entry.target.kind === "NewProperty") {
    return {
      kind: "blocked",
      reason: "A New Property operation owns this exact schema.",
      conflictingTargets: sameSchema,
    };
  }
  if (occurrenceResolution.kind !== "unique") {
    return {
      kind: "blocked",
      reason:
        occurrenceResolution.kind === "multiple"
          ? "The row has multiple authoritative occurrences."
          : "The row has no authoritative occurrence.",
      conflictingTargets: sameSchema,
    };
  }

  const expected = existingOccurrenceTargetFromOccurrence(
    occurrenceResolution.occurrence,
  );
  if (
    expected.kind !== "targetable" ||
    !metadataDraftTargetEquals(expected.target, entry.target)
  ) {
    return {
      kind: "blocked",
      reason:
        "The stored target no longer matches the complete occurrence target snapshot.",
      conflictingTargets: sameSchema,
    };
  }
  return { kind: "target", entry };
}

export type TargetDraftSchemaResolution =
  | { kind: "missing" }
  | { kind: "unique"; entry: MetadataDraftEntryV5 }
  | { kind: "ambiguous"; entries: MetadataDraftEntryV5[] };

export function targetDraftSchemaId(
  target: MetadataDraftTarget,
): SchemaDefinitionId {
  return target.schema_id;
}

export function findNewPropertyDraftByExactSchema(
  drafts: TargetDraftCollection | undefined,
  schemaId: SchemaDefinitionId,
): MetadataDraftEntryV5 | undefined {
  return Object.values(drafts ?? {}).find(
    (entry) =>
      entry.target.kind === "NewProperty" &&
      schemaDefinitionIdEquals(entry.target.schema_id, schemaId),
  );
}

/**
 * Temporary Add Property view: a schema may resolve to at most one exact
 * target draft. Never first-select when reconciled occurrences are ambiguous.
 */
export function resolveTargetDraftByExactSchema(
  drafts: TargetDraftCollection | undefined,
  schemaId: SchemaDefinitionId,
): TargetDraftSchemaResolution {
  const entries = Object.values(drafts ?? {}).filter((entry) =>
    schemaDefinitionIdEquals(targetDraftSchemaId(entry.target), schemaId),
  );
  if (entries.length === 0) return { kind: "missing" };
  if (entries.length === 1) return { kind: "unique", entry: entries[0] };
  return { kind: "ambiguous", entries };
}

export function targetDraftSchemas(
  drafts: TargetDraftCollection | undefined,
): SchemaDefinitionId[] {
  const result: SchemaDefinitionId[] = [];
  for (const entry of Object.values(drafts ?? {})) {
    const id = targetDraftSchemaId(entry.target);
    if (!result.some((candidate) => schemaDefinitionIdEquals(candidate, id))) {
      result.push(id);
    }
  }
  return result;
}

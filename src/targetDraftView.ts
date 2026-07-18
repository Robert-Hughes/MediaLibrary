import type {
  ImageMetadataOccurrencesState,
  MetadataDraftEdit,
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
} from "./types";
import type { TargetDraftCollection } from "./targetDraftEdits";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
import type { SchemaOccurrenceResolution } from "./utils/metadataOccurrences";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolveExactMetadataOccurrence,
  resolutionForSchema,
} from "./utils/metadataOccurrences";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
} from "./utils/metadataDraftTarget";
import { metadataOccurrenceIdEquals } from "./utils/metadataOccurrenceId";

type ExistingOccurrenceTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;

export interface SchemaDraftDisplayEntry {
  id: SchemaDefinitionId;
  edit: MetadataDraftEdit;
}

/**
 * Derived schema-row presentation only. Record keys exist for JavaScript
 * collection mechanics; entries are not persisted state or mutation inputs.
 */
export type SchemaDraftDisplayProjection = Record<
  string,
  SchemaDraftDisplayEntry
>;

export type SchemaDraftPresentationResolution =
  | { kind: "none" }
  | { kind: "target"; entry: MetadataTargetDraftEntry }
  | {
      kind: "blocked";
      reason: string;
      conflictingTargets: MetadataTargetDraftEntry[];
    };

interface LoadedPresentationContext {
  occurrences: MetadataOccurrence[];
  occurrenceIndex: ReturnType<typeof buildSchemaOccurrenceResolutionIndex>;
}

function loadedPresentationContext(
  occurrences: ImageMetadataOccurrencesState | undefined,
): LoadedPresentationContext | undefined {
  if (!Array.isArray(occurrences)) return undefined;
  return {
    occurrences,
    occurrenceIndex: buildSchemaOccurrenceResolutionIndex(occurrences),
  };
}

function resolveSchemaDraftWithContext(
  schemaId: SchemaDefinitionId,
  context: LoadedPresentationContext | undefined,
  targetDrafts: TargetDraftCollection | undefined,
): SchemaDraftPresentationResolution {
  const sameSchema = Object.values(targetDrafts ?? {}).filter((entry) =>
    schemaDefinitionIdEquals(entry.target.schema_id, schemaId),
  );
  if (sameSchema.length === 0) return { kind: "none" };
  if (sameSchema.length > 1) {
    return {
      kind: "blocked",
      reason: "Multiple exact targets own this schema.",
      conflictingTargets: sameSchema,
    };
  }
  if (!context) {
    return {
      kind: "blocked",
      reason: "Authoritative occurrences are not loaded.",
      conflictingTargets: sameSchema,
    };
  }

  const entry = sameSchema[0];
  const schemaResolution = resolutionForSchema(
    context.occurrenceIndex,
    schemaId,
  );

  if (entry.target.kind === "NewProperty") {
    if (schemaResolution.kind !== "missing") {
      return {
        kind: "blocked",
        reason: "The authoritative schema is already present.",
        conflictingTargets: sameSchema,
      };
    }
    return { kind: "target", entry };
  }

  const exact = resolveExactMetadataOccurrence(
    context.occurrences,
    entry.target.occurrence_id,
  );
  if (exact.kind !== "unique") {
    return {
      kind: "blocked",
      reason:
        exact.kind === "duplicate"
          ? "The exact occurrence ID is duplicated."
          : "The exact occurrence is missing.",
      conflictingTargets: sameSchema,
    };
  }

  if (schemaResolution.kind !== "unique") {
    return {
      kind: "blocked",
      reason:
        schemaResolution.kind === "multiple"
          ? "The schema has multiple authoritative occurrences."
          : "The schema has no authoritative occurrence.",
      conflictingTargets: sameSchema,
    };
  }

  const expected = existingOccurrenceTargetFromOccurrence(exact.occurrence);
  if (
    !schemaDefinitionIdEquals(exact.occurrence.schema_id, schemaId) ||
    exact.occurrence.tag_info === null ||
    !schemaDefinitionIdEquals(
      exact.occurrence.tag_info.id,
      exact.occurrence.schema_id,
    ) ||
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

/**
 * Resolve one schema-keyed display cell without selecting or collapsing exact
 * targets. A staged value is returned only after the authoritative occurrence
 * and complete target snapshot have been verified.
 */
export function resolveSchemaDraftForPresentation(input: {
  schemaId: SchemaDefinitionId;
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): SchemaDraftPresentationResolution {
  return resolveSchemaDraftWithContext(
    input.schemaId,
    loadedPresentationContext(input.occurrences),
    input.targetDrafts,
  );
}

/** Build the safe schema-keyed display projection for one file. */
export function buildSchemaDraftDisplayProjection(input: {
  occurrences: ImageMetadataOccurrencesState | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): SchemaDraftDisplayProjection {
  const projection: SchemaDraftDisplayProjection = {};
  const context = loadedPresentationContext(input.occurrences);
  for (const schemaId of targetDraftSchemas(input.targetDrafts)) {
    const resolution = resolveSchemaDraftWithContext(
      schemaId,
      context,
      input.targetDrafts,
    );
    if (resolution.kind !== "target") continue;
    projection[schemaDefinitionIdToken(schemaId)] = {
      id: structuredClone(schemaId),
      edit: structuredClone(resolution.entry.edit),
    };
  }
  return projection;
}

export type ExistingRowDraftResolution =
  | { kind: "none" }
  | { kind: "target"; entry: MetadataTargetDraftEntry }
  | {
      kind: "blocked";
      reason: string;
      conflictingTargets: MetadataTargetDraftEntry[];
    };

export type SupplementalOccurrenceDraftResolution =
  | { kind: "none" }
  | {
      kind: "target";
      entry: MetadataTargetDraftEntry & { target: ExistingOccurrenceTarget };
    }
  | {
      kind: "blocked";
      reason: string;
      conflictingTargets: MetadataTargetDraftEntry[];
    };

/**
 * Resolve ownership for one exact supplemental occurrence.
 */
export function resolveSupplementalOccurrenceDraft(
  occurrence: MetadataOccurrence,
  targetDrafts: TargetDraftCollection | undefined,
): SupplementalOccurrenceDraftResolution {
  const schemaId = occurrence.schema_id;
  const sameSchemaTargets = Object.values(targetDrafts ?? {}).filter((entry) =>
    schemaDefinitionIdEquals(entry.target.schema_id, schemaId),
  );
  if (occurrence.tag_info === null) {
    return {
      kind: "blocked",
      reason:
        "This occurrence retains an exact schema ID but has no resolved TagInfo and is read-only.",
      conflictingTargets: sameSchemaTargets,
    };
  }
  if (!schemaDefinitionIdEquals(occurrence.tag_info.id, schemaId)) {
    return {
      kind: "blocked",
      reason:
        "This occurrence's exact schema ID conflicts with its TagInfo and is read-only.",
      conflictingTargets: sameSchemaTargets,
    };
  }

  const relevantTargets = Object.values(targetDrafts ?? {}).filter(
    (
      entry,
    ): entry is MetadataTargetDraftEntry & {
      target: ExistingOccurrenceTarget;
    } =>
      entry.target.kind === "ExistingOccurrence" &&
      metadataOccurrenceIdEquals(entry.target.occurrence_id, occurrence.id),
  );
  if (relevantTargets.length === 0) return { kind: "none" };
  if (relevantTargets.length > 1) {
    return {
      kind: "blocked",
      reason: "Multiple target-aware operations own this exact occurrence.",
      conflictingTargets: relevantTargets,
    };
  }

  const entry = relevantTargets[0];
  const expected = existingOccurrenceTargetFromOccurrence(occurrence);
  if (
    expected.kind === "targetable" &&
    metadataDraftTargetEquals(expected.target, entry.target)
  ) {
    return {
      kind: "target",
      entry: { ...entry, target: entry.target },
    };
  }

  const ownsDifferentOccurrence = !metadataOccurrenceIdEquals(
    entry.target.occurrence_id,
    occurrence.id,
  );
  return {
    kind: "blocked",
    reason: ownsDifferentOccurrence
      ? "Another concrete occurrence owns this exact target slot."
      : "The stored target no longer matches this occurrence's complete schema and runtime selector snapshot.",
    conflictingTargets: relevantTargets,
  };
}

/**
 * Resolve draft ownership for one ordinary schema-oriented row without ever
 * selecting a target merely because its schema matches.
 */
export function resolveExistingRowDraft(
  schemaId: SchemaDefinitionId,
  occurrenceResolution: SchemaOccurrenceResolution,
  targetDrafts: TargetDraftCollection | undefined,
): ExistingRowDraftResolution {
  if (occurrenceResolution.kind !== "unique") {
    return {
      kind: "blocked",
      reason:
        occurrenceResolution.kind === "multiple"
          ? "The row has multiple authoritative occurrences."
          : "The row has no authoritative occurrence.",
      conflictingTargets: [],
    };
  }
  if (
    !schemaDefinitionIdEquals(
      occurrenceResolution.occurrence.schema_id,
      schemaId,
    )
  ) {
    return {
      kind: "blocked",
      reason: "The row occurrence no longer matches its exact schema.",
      conflictingTargets: [],
    };
  }

  const expected = existingOccurrenceTargetFromOccurrence(
    occurrenceResolution.occurrence,
  );
  if (expected.kind !== "targetable") {
    return {
      kind: "blocked",
      reason: expected.reason,
      conflictingTargets: [],
    };
  }
  const slot = metadataDraftTargetSlotToken(expected.target);
  const entry = targetDrafts?.[slot];
  if (entry === undefined) return { kind: "none" };
  if (!metadataDraftTargetEquals(expected.target, entry.target)) {
    return {
      kind: "blocked",
      reason:
        "The stored target no longer matches the complete occurrence target snapshot.",
      conflictingTargets: [entry],
    };
  }
  return { kind: "target", entry };
}

export type TargetDraftSchemaResolution =
  | { kind: "missing" }
  | { kind: "unique"; entry: MetadataTargetDraftEntry }
  | { kind: "ambiguous"; entries: MetadataTargetDraftEntry[] };

export function targetDraftSchemaId(
  target: MetadataDraftTarget,
): SchemaDefinitionId {
  return target.schema_id;
}

/**
 * Resolve exact-schema target ownership for a derived display projection. A
 * schema may resolve to at most one exact target; never first-select when
 * reconciled occurrences are ambiguous.
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

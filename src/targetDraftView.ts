import type {
  FileMetadataOccurrencesState,
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
import {
  buildSchemaOccurrenceResolutionIndex,
  resolveExactMetadataOccurrence,
  resolutionForSchema,
} from "./utils/metadataOccurrences";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./utils/metadataDraftTarget";

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
  occurrences: FileMetadataOccurrencesState | undefined,
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
  occurrences: FileMetadataOccurrencesState | undefined;
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
  occurrences: FileMetadataOccurrencesState | undefined;
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

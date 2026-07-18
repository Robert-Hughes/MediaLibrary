import type { TargetDraftCollection } from "./targetDraftEdits";
import type {
  ImageMetadataOccurrencesState,
  MetadataDraftTarget,
  SchemaDefinitionId,
  TargetDraftPersistenceState,
} from "./types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
} from "./utils/metadataDraftTarget";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
import { findDuplicateMetadataOccurrenceId } from "./utils/metadataOccurrences";
import { wireStructuralEqual } from "./utils/wireStructuralEquality";

type ExistingOccurrenceTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;

export interface MetadataRemovalTargetPlan {
  upserts: Array<{
    target: ExistingOccurrenceTarget;
    edit: {
      intent: "Delete";
      value: null;
    };
  }>;
  deletes: MetadataDraftTarget[];
  noops: SchemaDefinitionId[];
}

export interface MetadataRemovalPreview {
  existingFieldsToDelete: number;
  stagedCreationsToCancel: number;
  noOpFields: number;
  affectedCount: number;
}

export type MetadataRemovalFilesPreview =
  | {
      kind: "ready";
      photoCount: number;
      affectedPhotoCount: number;
      existingFieldsToDelete: number;
      stagedCreationsToCancel: number;
      noOpPhotoCount: number;
    }
  | {
      kind: "blocked";
      relativePath: string;
      reason: string;
    };

export type MetadataRemovalTargetPlanErrorCode =
  | "occurrences-loading"
  | "empty-request"
  | "duplicate-schema"
  | "untargetable-occurrence"
  | "stale-target-owner"
  | "target-slot-mismatch"
  | "exact-slot-collision"
  | "duplicate-occurrence-id";
export class MetadataRemovalTargetPlanError extends Error {
  constructor(
    readonly code: MetadataRemovalTargetPlanErrorCode,
    message: string,
    readonly schemaId?: SchemaDefinitionId,
  ) {
    super(message);
    this.name = "MetadataRemovalTargetPlanError";
  }
}

function describe(id: SchemaDefinitionId): string {
  return formatSchemaDefinitionIdForDiagnostics(id);
}

/**
 * Plans exact target-aware removals without mutating any input. A request is
 * validated completely before any plan is returned.
 */
export function planMetadataRemovalTargets(input: {
  schemaIds: readonly SchemaDefinitionId[];
  occurrences: ImageMetadataOccurrencesState;
  targetDrafts: TargetDraftCollection | undefined;
}): MetadataRemovalTargetPlan {
  const { schemaIds, occurrences, targetDrafts } = input;
  if (!Array.isArray(occurrences)) {
    throw new MetadataRemovalTargetPlanError(
      "occurrences-loading",
      "Authoritative metadata occurrences are still loading. Nothing was removed.",
    );
  }
  if (schemaIds.length === 0) {
    throw new MetadataRemovalTargetPlanError(
      "empty-request",
      "At least one exact metadata schema is required. Nothing was removed.",
    );
  }

  const duplicateOccurrence = findDuplicateMetadataOccurrenceId(occurrences);
  if (duplicateOccurrence) {
    throw new MetadataRemovalTargetPlanError(
      "duplicate-occurrence-id",
      "A complete authoritative metadata occurrence ID is duplicated. Nothing was removed.",
    );
  }
  const ids = schemaIds.map((id) => structuredClone(id));
  const seen = new Set<string>();
  for (const id of ids) {
    const token = schemaDefinitionIdToken(id);
    if (seen.has(token)) {
      throw new MetadataRemovalTargetPlanError(
        "duplicate-schema",
        `The removal request contains the same exact schema more than once (${describe(id)}). Nothing was removed.`,
        structuredClone(id),
      );
    }
    seen.add(token);
  }

  const plan: MetadataRemovalTargetPlan = {
    upserts: [],
    deletes: [],
    noops: [],
  };

  for (const [storedSlot, entry] of Object.entries(targetDrafts ?? {})) {
    if (storedSlot !== metadataDraftTargetSlotToken(entry.target)) {
      throw new MetadataRemovalTargetPlanError(
        "target-slot-mismatch",
        "A stored target-aware draft is filed under a slot that does not match its complete target. Nothing was removed.",
        structuredClone(entry.target.schema_id),
      );
    }
  }

  for (const id of ids) {
    const authoritative = occurrences.filter((occurrence) =>
      schemaDefinitionIdEquals(occurrence.schema_id, id),
    );
    const sameSchemaDrafts = Object.values(targetDrafts ?? {}).filter((entry) =>
      schemaDefinitionIdEquals(entry.target.schema_id, id),
    );
    const authoritativeSlots = new Set<string>();

    for (const occurrence of authoritative) {
      const targetability = existingOccurrenceTargetFromOccurrence(occurrence);
      if (targetability.kind !== "targetable") {
        throw new MetadataRemovalTargetPlanError(
          "untargetable-occurrence",
          `${targetability.reason} A removal draft was not created for ${describe(id)}. Nothing was removed.`,
          structuredClone(id),
        );
      }
      const expected = targetability.target;
      const slot = metadataDraftTargetSlotToken(expected);
      if (authoritativeSlots.has(slot)) {
        throw new MetadataRemovalTargetPlanError(
          "exact-slot-collision",
          `Several authoritative occurrences resolve to the same exact target slot for ${describe(id)}. Nothing was removed.`,
          structuredClone(id),
        );
      }
      authoritativeSlots.add(slot);
      const owner = targetDrafts?.[slot];
      if (owner && !metadataDraftTargetEquals(owner.target, expected)) {
        throw new MetadataRemovalTargetPlanError(
          "stale-target-owner",
          `A stale complete target claims the exact occurrence slot for ${describe(id)}. Nothing was removed.`,
          structuredClone(id),
        );
      }
      if (
        owner &&
        wireStructuralEqual(owner.edit, {
          intent: "Delete",
          value: null,
        })
      ) {
        plan.noops.push(structuredClone(id));
        continue;
      }
      plan.upserts.push({
        target: structuredClone(expected),
        edit: { intent: "Delete", value: null },
      });
    }

    for (const entry of sameSchemaDrafts) {
      if (entry.target.kind === "NewProperty") {
        plan.deletes.push(structuredClone(entry.target));
      } else if (
        !authoritativeSlots.has(metadataDraftTargetSlotToken(entry.target))
      ) {
        throw new MetadataRemovalTargetPlanError(
          "stale-target-owner",
          `An ExistingOccurrence draft owns ${describe(id)}, but its exact authoritative occurrence is missing. Nothing was removed.`,
          structuredClone(id),
        );
      }
    }

    if (authoritative.length === 0 && sameSchemaDrafts.length === 0) {
      plan.noops.push(structuredClone(id));
    }
  }

  return structuredClone(plan);
}

/** Derives target-aware removal counts from the exact mutation planner. */
export function previewMetadataRemovalTargets(
  input: Parameters<typeof planMetadataRemovalTargets>[0],
): MetadataRemovalPreview {
  const plan = planMetadataRemovalTargets(input);
  const existingFieldsToDelete = plan.upserts.length;
  const stagedCreationsToCancel = plan.deletes.length;
  return {
    existingFieldsToDelete,
    stagedCreationsToCancel,
    noOpFields: plan.noops.length,
    affectedCount: existingFieldsToDelete + stagedCreationsToCancel,
  };
}

/**
 * Previews one exact field across files without mutating any store. Each file
 * is planned independently so the first unsafe path can be reported.
 */
export function previewMetadataRemovalFiles(input: {
  schemaId: SchemaDefinitionId;
  relativePaths: readonly string[];
  targetDraftPersistence: TargetDraftPersistenceState;
  occurrencesForPath: (relativePath: string) => ImageMetadataOccurrencesState;
  targetDraftsForPath: (
    relativePath: string,
  ) => TargetDraftCollection | undefined;
}): MetadataRemovalFilesPreview {
  const paths = [...new Set(input.relativePaths)];
  if (input.targetDraftPersistence.status !== "ready") {
    return {
      kind: "blocked",
      relativePath: paths[0] ?? "",
      reason:
        "Target-aware draft persistence is not ready. Nothing was removed.",
    };
  }

  let affectedPhotoCount = 0;
  let existingFieldsToDelete = 0;
  let stagedCreationsToCancel = 0;
  let noOpPhotoCount = 0;

  for (const relativePath of paths) {
    try {
      const preview = previewMetadataRemovalTargets({
        schemaIds: [input.schemaId],
        occurrences: input.occurrencesForPath(relativePath),
        targetDrafts: input.targetDraftsForPath(relativePath),
      });
      existingFieldsToDelete += preview.existingFieldsToDelete;
      stagedCreationsToCancel += preview.stagedCreationsToCancel;
      if (preview.affectedCount === 0) {
        noOpPhotoCount += 1;
      } else {
        affectedPhotoCount += 1;
      }
    } catch (error) {
      return {
        kind: "blocked",
        relativePath,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    kind: "ready",
    photoCount: paths.length,
    affectedPhotoCount,
    existingFieldsToDelete,
    stagedCreationsToCancel,
    noOpPhotoCount,
  };
}

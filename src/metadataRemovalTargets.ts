import type { TargetDraftCollection } from "./targetDraftEdits";
import type {
  ImageMetadataOccurrencesState,
  MetadataDraftCollection,
  MetadataDraftTarget,
  SchemaDefinitionId,
  TargetDraftPersistenceStateV5,
} from "./types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./utils/metadataDraftTarget";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolutionForSchema,
} from "./utils/metadataOccurrences";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
import { wireStructuralEqual } from "./utils/wireStructuralEquality";

type ExistingOccurrenceTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;

export interface MetadataRemovalTargetPlanV5 {
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

export interface MetadataRemovalPreviewV5 {
  existingFieldsToDelete: number;
  stagedCreationsToCancel: number;
  noOpFields: number;
  affectedCount: number;
}

export type MetadataRemovalFilesPreviewV5 =
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
  | "multiple-occurrences"
  | "untargetable-occurrence"
  | "legacy-owner"
  | "multiple-target-owners"
  | "stale-target-owner"
  | "incompatible-target-owner";

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

function sameSchemaOwners(
  drafts: TargetDraftCollection | undefined,
  id: SchemaDefinitionId,
) {
  return Object.values(drafts ?? {}).filter((entry) =>
    schemaDefinitionIdEquals(entry.target.schema_id, id),
  );
}

/**
 * Plans exact schema-v5 removals without mutating any input. A request is
 * validated completely before any plan is returned.
 */
export function planMetadataRemovalTargetsV5(input: {
  schemaIds: readonly SchemaDefinitionId[];
  occurrences: ImageMetadataOccurrencesState;
  legacyDrafts: MetadataDraftCollection | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): MetadataRemovalTargetPlanV5 {
  const { schemaIds, occurrences, legacyDrafts, targetDrafts } = input;
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

  // Legacy ownership blocks the complete request before target planning.
  for (const id of ids) {
    if (
      Object.values(legacyDrafts ?? {}).some((entry) =>
        schemaDefinitionIdEquals(entry.id, id),
      )
    ) {
      throw new MetadataRemovalTargetPlanError(
        "legacy-owner",
        `The exact field ${describe(id)} has a schema-v4 draft. Apply or discard the legacy draft first. Nothing was removed.`,
        structuredClone(id),
      );
    }
  }

  const index = buildSchemaOccurrenceResolutionIndex(occurrences);
  const plan: MetadataRemovalTargetPlanV5 = {
    upserts: [],
    deletes: [],
    noops: [],
  };

  for (const id of ids) {
    const resolution = resolutionForSchema(index, id);
    const owners = sameSchemaOwners(targetDrafts, id);
    if (owners.length > 1) {
      throw new MetadataRemovalTargetPlanError(
        "multiple-target-owners",
        `Multiple target-aware operations own ${describe(id)}. Apply or discard them first. Nothing was removed.`,
        structuredClone(id),
      );
    }

    if (resolution.kind === "multiple") {
      throw new MetadataRemovalTargetPlanError(
        "multiple-occurrences",
        `Several authoritative occurrences share ${describe(id)}, so no concrete occurrence was selected. Nothing was removed.`,
        structuredClone(id),
      );
    }

    if (resolution.kind === "missing") {
      if (owners.length === 0) {
        plan.noops.push(structuredClone(id));
        continue;
      }
      const owner = owners[0];
      if (owner.target.kind === "ExistingOccurrence") {
        throw new MetadataRemovalTargetPlanError(
          "stale-target-owner",
          `An ExistingOccurrence draft owns ${describe(id)}, but its authoritative occurrence is missing. Apply or discard the stale draft first. Nothing was removed.`,
          structuredClone(id),
        );
      }
      plan.deletes.push(structuredClone(owner.target));
      continue;
    }

    const targetability = existingOccurrenceTargetFromOccurrence(
      resolution.occurrence,
    );
    if (targetability.kind !== "targetable") {
      throw new MetadataRemovalTargetPlanError(
        "untargetable-occurrence",
        `${targetability.reason} A removal draft was not created for ${describe(id)}. Nothing was removed.`,
        structuredClone(id),
      );
    }
    const expected = targetability.target;

    if (owners.length === 1) {
      const owner = owners[0];
      if (
        owner.target.kind !== "ExistingOccurrence" ||
        !metadataDraftTargetEquals(owner.target, expected)
      ) {
        throw new MetadataRemovalTargetPlanError(
          "incompatible-target-owner",
          `A different target-aware destination owns ${describe(id)}. Apply or discard it first. Nothing was removed.`,
          structuredClone(id),
        );
      }
      if (
        wireStructuralEqual(owner.edit, {
          intent: "Delete",
          value: null,
        })
      ) {
        plan.noops.push(structuredClone(id));
        continue;
      }
    }

    plan.upserts.push({
      target: structuredClone(expected),
      edit: { intent: "Delete", value: null },
    });
  }

  return structuredClone(plan);
}

/** Derives target-aware removal counts from the exact mutation planner. */
export function previewMetadataRemovalTargetsV5(
  input: Parameters<typeof planMetadataRemovalTargetsV5>[0],
): MetadataRemovalPreviewV5 {
  const plan = planMetadataRemovalTargetsV5(input);
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
export function previewMetadataRemovalFilesV5(input: {
  schemaId: SchemaDefinitionId;
  relativePaths: readonly string[];
  targetDraftPersistence: TargetDraftPersistenceStateV5;
  occurrencesForPath: (relativePath: string) => ImageMetadataOccurrencesState;
  legacyDraftsForPath: (
    relativePath: string,
  ) => MetadataDraftCollection | undefined;
  targetDraftsForPath: (
    relativePath: string,
  ) => TargetDraftCollection | undefined;
}): MetadataRemovalFilesPreviewV5 {
  const paths = [...new Set(input.relativePaths)];
  if (input.targetDraftPersistence.status !== "ready") {
    return {
      kind: "blocked",
      relativePath: paths[0] ?? "",
      reason: "Schema-v5 draft persistence is not ready. Nothing was removed.",
    };
  }

  let affectedPhotoCount = 0;
  let existingFieldsToDelete = 0;
  let stagedCreationsToCancel = 0;
  let noOpPhotoCount = 0;

  for (const relativePath of paths) {
    try {
      const preview = previewMetadataRemovalTargetsV5({
        schemaIds: [input.schemaId],
        occurrences: input.occurrencesForPath(relativePath),
        legacyDrafts: input.legacyDraftsForPath(relativePath),
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

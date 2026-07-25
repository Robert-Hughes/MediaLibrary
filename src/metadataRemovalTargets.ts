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
import {
  findDuplicateMetadataOccurrenceId,
  resolveExactMetadataOccurrence,
} from "./utils/metadataOccurrences";
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
      fileCount: number;
      affectedFileCount: number;
      existingFieldsToDelete: number;
      stagedCreationsToCancel: number;
      noOpFileCount: number;
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

export interface MetadataTargetRemovalPlan {
  upserts: Array<{
    target: ExistingOccurrenceTarget;
    edit: {
      intent: "Delete";
      value: null;
    };
  }>;
  deletes: MetadataDraftTarget[];
  noops: MetadataDraftTarget[];
}

export type MetadataTargetRemovalPlanErrorCode =
  | "occurrences-loading"
  | "empty-request"
  | "duplicate-target-slot"
  | "target-slot-mismatch"
  | "duplicate-stored-target-slot"
  | "missing-occurrence"
  | "duplicate-occurrence-id"
  | "untargetable-occurrence"
  | "changed-schema-snapshot"
  | "changed-selector-snapshot"
  | "missing-new-property-draft"
  | "stale-target-owner";

export class MetadataTargetRemovalPlanError extends Error {
  constructor(
    readonly code: MetadataTargetRemovalPlanErrorCode,
    message: string,
    readonly target?: MetadataDraftTarget,
  ) {
    super(message);
    this.name = "MetadataTargetRemovalPlanError";
  }
}

function validateStoredTargetCollection(
  targetDrafts: TargetDraftCollection | undefined,
): void {
  const seen = new Set<string>();
  for (const [recordKey, entry] of Object.entries(targetDrafts ?? {})) {
    const expected = metadataDraftTargetSlotToken(entry.target);
    if (recordKey !== expected) {
      throw new MetadataTargetRemovalPlanError(
        "target-slot-mismatch",
        "A stored target-aware draft is filed under a slot that does not match its complete target. Nothing was removed.",
        structuredClone(entry.target),
      );
    }
    if (seen.has(expected)) {
      throw new MetadataTargetRemovalPlanError(
        "duplicate-stored-target-slot",
        "Several stored target-aware drafts claim the same logical slot. Nothing was removed.",
        structuredClone(entry.target),
      );
    }
    seen.add(expected);
  }
}

/**
 * Plans removals for complete exact targets selected by an occurrence-oriented
 * view. The full request is validated before a mutation plan is returned.
 */
export function planMetadataTargetRemovals(input: {
  targets: readonly MetadataDraftTarget[];
  occurrences: ImageMetadataOccurrencesState;
  targetDrafts: TargetDraftCollection | undefined;
}): MetadataTargetRemovalPlan {
  const { targets, occurrences, targetDrafts } = input;
  if (!Array.isArray(occurrences)) {
    throw new MetadataTargetRemovalPlanError(
      "occurrences-loading",
      "Authoritative metadata occurrences are still loading. Nothing was removed.",
    );
  }
  if (targets.length === 0) {
    throw new MetadataTargetRemovalPlanError(
      "empty-request",
      "At least one exact metadata target is required. Nothing was removed.",
    );
  }

  validateStoredTargetCollection(targetDrafts);

  const requestedSlots = new Set<string>();
  const clonedTargets = targets.map((target) => structuredClone(target));
  for (const target of clonedTargets) {
    const slot = metadataDraftTargetSlotToken(target);
    if (requestedSlots.has(slot)) {
      throw new MetadataTargetRemovalPlanError(
        "duplicate-target-slot",
        "The removal request contains the same logical target slot more than once. Nothing was removed.",
        target,
      );
    }
    requestedSlots.add(slot);
  }

  const plan: MetadataTargetRemovalPlan = {
    upserts: [],
    deletes: [],
    noops: [],
  };

  for (const target of clonedTargets) {
    const slot = metadataDraftTargetSlotToken(target);
    const owner = targetDrafts?.[slot];

    if (target.kind === "NewProperty") {
      if (owner === undefined) {
        throw new MetadataTargetRemovalPlanError(
          "missing-new-property-draft",
          "The selected New Property target no longer has an exact stored draft. Nothing was removed.",
          target,
        );
      }
      if (!metadataDraftTargetEquals(owner.target, target)) {
        throw new MetadataTargetRemovalPlanError(
          "stale-target-owner",
          "A stale complete target owns the selected New Property slot. Nothing was removed.",
          target,
        );
      }
      plan.deletes.push(structuredClone(target));
      continue;
    }

    const exact = resolveExactMetadataOccurrence(
      occurrences,
      target.occurrence_id,
    );
    if (exact.kind === "missing") {
      throw new MetadataTargetRemovalPlanError(
        "missing-occurrence",
        "The selected exact metadata occurrence is no longer present. Nothing was removed.",
        target,
      );
    }
    if (exact.kind === "duplicate") {
      throw new MetadataTargetRemovalPlanError(
        "duplicate-occurrence-id",
        "The selected complete metadata occurrence ID is duplicated. Nothing was removed.",
        target,
      );
    }

    const current = existingOccurrenceTargetFromOccurrence(exact.occurrence);
    if (current.kind !== "targetable") {
      throw new MetadataTargetRemovalPlanError(
        "untargetable-occurrence",
        `${current.reason} Nothing was removed.`,
        target,
      );
    }
    if (!schemaDefinitionIdEquals(current.target.schema_id, target.schema_id)) {
      throw new MetadataTargetRemovalPlanError(
        "changed-schema-snapshot",
        "The selected occurrence's exact schema snapshot has changed. Nothing was removed.",
        target,
      );
    }
    if (!metadataDraftTargetEquals(current.target, target)) {
      throw new MetadataTargetRemovalPlanError(
        "changed-selector-snapshot",
        "The selected occurrence's exact runtime selector snapshot has changed. Nothing was removed.",
        target,
      );
    }
    if (owner && !metadataDraftTargetEquals(owner.target, target)) {
      throw new MetadataTargetRemovalPlanError(
        "stale-target-owner",
        "A stale complete target owns the selected occurrence slot. Nothing was removed.",
        target,
      );
    }
    if (
      owner &&
      wireStructuralEqual(owner.edit, { intent: "Delete", value: null })
    ) {
      plan.noops.push(structuredClone(target));
      continue;
    }
    plan.upserts.push({
      target: structuredClone(target),
      edit: { intent: "Delete", value: null },
    });
  }

  return structuredClone(plan);
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
    const exactTargets: MetadataDraftTarget[] = [];

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
      exactTargets.push(structuredClone(expected));
    }

    for (const entry of sameSchemaDrafts) {
      if (entry.target.kind === "NewProperty") {
        exactTargets.push(structuredClone(entry.target));
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

    if (exactTargets.length === 0) {
      plan.noops.push(structuredClone(id));
      continue;
    }

    try {
      const exactPlan = planMetadataTargetRemovals({
        targets: exactTargets,
        occurrences,
        targetDrafts,
      });
      plan.upserts.push(
        ...exactPlan.upserts.map((item) => structuredClone(item)),
      );
      plan.deletes.push(
        ...exactPlan.deletes.map((target) => structuredClone(target)),
      );
      plan.noops.push(...exactPlan.noops.map(() => structuredClone(id)));
    } catch (error) {
      if (!(error instanceof MetadataTargetRemovalPlanError)) throw error;
      const code: MetadataRemovalTargetPlanErrorCode =
        error.code === "duplicate-occurrence-id"
          ? "duplicate-occurrence-id"
          : error.code === "target-slot-mismatch" ||
              error.code === "duplicate-stored-target-slot"
            ? "target-slot-mismatch"
            : error.code === "stale-target-owner"
              ? "stale-target-owner"
              : "untargetable-occurrence";
      throw new MetadataRemovalTargetPlanError(
        code,
        `${error.message} Exact schema: ${describe(id)}.`,
        structuredClone(id),
      );
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

  let affectedFileCount = 0;
  let existingFieldsToDelete = 0;
  let stagedCreationsToCancel = 0;
  let noOpFileCount = 0;

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
        noOpFileCount += 1;
      } else {
        affectedFileCount += 1;
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
    fileCount: paths.length,
    affectedFileCount,
    existingFieldsToDelete,
    stagedCreationsToCancel,
    noOpFileCount,
  };
}

import type {
  FileMetadataOccurrencesState,
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataTargetDraftEntry,
  MetadataValue,
  SchemaDefinitionId,
  TagInfo,
} from "./types";
import { metadataValueEqual } from "./types";
import type {
  ExactTargetMutationBatchItem,
  TargetDraftCollection,
} from "./targetDraftEdits";
import { metadataTargetDraftEntryEqualsExact } from "./targetDraftEdits";
import type { GpsTagGroup } from "./metadata/tag_overrides";
import {
  planGpsTargetDraftBatch,
  validateGpsTargetDraftEntries,
} from "./gpsTargetDrafts";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "./utils/metadataDraftTarget";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdEquals,
} from "./utils/schemaDefinitionId";
import {
  findDuplicateMetadataOccurrenceId,
  resolveExactMetadataOccurrence,
} from "./utils/metadataOccurrences";
import { applyMetadataDraftEditExactly } from "./utils/effectiveMetadata";
import { mergeMetadataValueExactly } from "./metadataValueMerge";
import { classifyNewPropertyDestination } from "./utils/newPropertyDestinationSafety";
import {
  metadataWriteSelectorsEqual,
  validateFamily1Group,
} from "./utils/metadataWriteTarget";
import { tagInfoSupportsMetadataWrite } from "./utils/metadataWriteSupport";
import { planMetadataRemovalTargets } from "./metadataRemovalTargets";

export interface BulkMetadataFileState {
  relativePath: string;
  occurrences: FileMetadataOccurrencesState;
  targetDrafts: TargetDraftCollection | undefined;
}

export type BulkMetadataDraftRequest =
  | {
      operation: "Set";
      tagInfo: TagInfo;
      edit: MetadataDraftEdit;
      merge: boolean;
    }
  | {
      operation: "Delete";
      schemaId: SchemaDefinitionId;
    }
  | {
      operation: "SetGps";
      group: GpsTagGroup;
      edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>;
    }
  | {
      operation: "DeleteGps";
      group: GpsTagGroup;
    };

export interface BulkMetadataDraftPreview {
  fileCount: number;
  affectedFileCount: number;
  noOpFileCount: number;
  existingOccurrencesSet: number;
  newPropertiesSet: number;
  existingOccurrencesDeleted: number;
  stagedCreationsCancelled: number;
  draftsCleared: number;
}

export interface BulkMetadataDraftPlan {
  mutations: ExactTargetMutationBatchItem[];
  preview: BulkMetadataDraftPreview;
}

export type BulkMetadataDraftPlanErrorCode =
  | "empty-selection"
  | "duplicate-path"
  | "occurrences-loading"
  | "duplicate-occurrence-id"
  | "invalid-edit"
  | "schema-mismatch"
  | "read-only-schema"
  | "unsupported-schema-kind"
  | "stored-slot-mismatch"
  | "selector-collision"
  | "untargetable-occurrence"
  | "stale-existing-draft"
  | "stale-target-owner"
  | "invalid-new-property-target"
  | "occupied-new-property-target"
  | "unpreviewable-draft"
  | "merge-unsupported";

export class BulkMetadataDraftPlanError extends Error {
  constructor(
    readonly code: BulkMetadataDraftPlanErrorCode,
    message: string,
    readonly relativePath?: string,
    readonly schemaId?: SchemaDefinitionId,
  ) {
    super(message);
    this.name = "BulkMetadataDraftPlanError";
  }
}

function fail(
  code: BulkMetadataDraftPlanErrorCode,
  message: string,
  relativePath?: string,
  schemaId?: SchemaDefinitionId,
): never {
  throw new BulkMetadataDraftPlanError(
    code,
    message,
    relativePath,
    schemaId === undefined ? undefined : structuredClone(schemaId),
  );
}
function emptyPreview(fileCount: number): BulkMetadataDraftPreview {
  return {
    fileCount,
    affectedFileCount: 0,
    noOpFileCount: 0,
    existingOccurrencesSet: 0,
    newPropertiesSet: 0,
    existingOccurrencesDeleted: 0,
    stagedCreationsCancelled: 0,
    draftsCleared: 0,
  };
}

function requireOccurrences(file: BulkMetadataFileState): MetadataOccurrence[] {
  if (!Array.isArray(file.occurrences)) {
    fail(
      "occurrences-loading",
      `Authoritative metadata occurrences are still loading for '${file.relativePath}'. Nothing was staged.`,
      file.relativePath,
    );
  }
  if (findDuplicateMetadataOccurrenceId(file.occurrences)) {
    fail(
      "duplicate-occurrence-id",
      `A complete authoritative metadata occurrence ID is duplicated in '${file.relativePath}'. Nothing was staged.`,
      file.relativePath,
    );
  }
  return file.occurrences;
}

function validateStoredDrafts(
  file: BulkMetadataFileState,
): readonly MetadataTargetDraftEntry[] {
  const entries = Object.entries(file.targetDrafts ?? {});
  const targets: MetadataDraftTarget[] = [];
  for (const [slot, entry] of entries) {
    if (slot !== metadataDraftTargetSlotToken(entry.target)) {
      fail(
        "stored-slot-mismatch",
        `A stored target-aware draft in '${file.relativePath}' is filed under a slot that does not match its complete target. Nothing was staged.`,
        file.relativePath,
        entry.target.schema_id,
      );
    }
    if (
      targets.some((target) =>
        metadataWriteSelectorsEqual(
          target.write_target,
          entry.target.write_target,
        ),
      )
    ) {
      fail(
        "selector-collision",
        `Several stored target-aware drafts in '${file.relativePath}' use the same ExifTool destination. Nothing was staged.`,
        file.relativePath,
        entry.target.schema_id,
      );
    }
    targets.push(entry.target);
  }
  return entries.map(([, entry]) => entry);
}

function validateSetRequest(
  request: Extract<BulkMetadataDraftRequest, { operation: "Set" }>,
): { intent: "Set"; value: MetadataValue } {
  if (request.edit.intent !== "Set" || request.edit.value === null) {
    fail(
      "invalid-edit",
      "Bulk Set requires one non-null semantic Set value.",
      undefined,
      request.tagInfo.id,
    );
  }
  if (!request.tagInfo.writable) {
    fail(
      "read-only-schema",
      "The selected exact schema is read-only. Nothing was staged.",
      undefined,
      request.tagInfo.id,
    );
  }
  if (!tagInfoSupportsMetadataWrite(request.tagInfo)) {
    fail(
      "unsupported-schema-kind",
      "The selected exact schema kind is not supported by the metadata write pipeline. Nothing was staged.",
      undefined,
      request.tagInfo.id,
    );
  }
  return { intent: "Set", value: request.edit.value };
}

function effectiveValue(
  file: BulkMetadataFileState,
  occurrence: MetadataOccurrence | undefined,
  owner: MetadataTargetDraftEntry | undefined,
  info: TagInfo,
): MetadataValue | undefined {
  const current = occurrence?.value;
  if (owner === undefined) return current;
  const applied = applyMetadataDraftEditExactly(current, owner.edit, info.kind);
  if (!applied.applied) {
    fail(
      "unpreviewable-draft",
      `A staged edit for '${file.relativePath}' cannot be composed safely: ${applied.reason}`,
      file.relativePath,
      info.id,
    );
  }
  return applied.value;
}

function desiredSetValue(
  file: BulkMetadataFileState,
  info: TagInfo,
  editValue: MetadataValue,
  merge: boolean,
  current: MetadataValue | undefined,
): MetadataValue {
  if (!merge) return structuredClone(editValue);
  const result = mergeMetadataValueExactly(info.kind, current, editValue);
  if (result.kind === "unsupported") {
    fail(
      "merge-unsupported",
      `Cannot merge ${formatSchemaDefinitionIdForDiagnostics(info.id)} in '${file.relativePath}': ${result.reason}`,
      file.relativePath,
      info.id,
    );
  }
  return result.value;
}

function validateNewPropertyTarget(
  file: BulkMetadataFileState,
  occurrences: readonly MetadataOccurrence[],
  target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
  info: TagInfo,
): void {
  if (!schemaDefinitionIdEquals(target.schema_id, info.id)) {
    fail(
      "schema-mismatch",
      `A staged New Property target in '${file.relativePath}' has the wrong exact schema snapshot. Nothing was staged.`,
      file.relativePath,
      info.id,
    );
  }
  const expected = newPropertyDraftTarget(info);
  if (
    expected.kind !== "available" ||
    expected.target.write_target.group7 !== target.write_target.group7 ||
    expected.target.write_target.tag_name !== target.write_target.tag_name ||
    validateFamily1Group(target.write_target.group1) !== null
  ) {
    fail(
      "invalid-new-property-target",
      `A New Property destination for '${file.relativePath}' is no longer eligible. Nothing was staged.`,
      file.relativePath,
      info.id,
    );
  }
  const safety = classifyNewPropertyDestination({
    schemaId: info.id,
    writeTarget: target.write_target,
    occurrences,
    pendingTargets: Object.values(file.targetDrafts ?? {}).map(
      (entry) => entry.target,
    ),
    ignoredPendingTarget: target,
  });
  if (safety.kind !== "available") {
    fail(
      "occupied-new-property-target",
      `A New Property destination for '${file.relativePath}' is ${safety.kind.replace(/-/g, " ")}. Nothing was staged.`,
      file.relativePath,
      info.id,
    );
  }
}

function planTargetSet(input: {
  target: MetadataDraftTarget;
  authoritativeValue: MetadataValue | undefined;
  effectiveValue: MetadataValue | undefined;
  desiredValue: MetadataValue;
  owner: MetadataTargetDraftEntry | undefined;
  upserts: MetadataTargetDraftEntry[];
  deletes: MetadataDraftTarget[];
  preview: BulkMetadataDraftPreview;
}): boolean {
  if (metadataValueEqual(input.effectiveValue, input.desiredValue)) {
    return false;
  }
  if (
    input.owner !== undefined &&
    metadataValueEqual(input.authoritativeValue, input.desiredValue)
  ) {
    input.deletes.push(structuredClone(input.target));
    input.preview.draftsCleared += 1;
    return true;
  }

  const entry: MetadataTargetDraftEntry = {
    target: structuredClone(input.target),
    edit: { intent: "Set", value: structuredClone(input.desiredValue) },
  };
  if (
    input.owner !== undefined &&
    metadataTargetDraftEntryEqualsExact(input.owner, entry)
  ) {
    return false;
  }
  input.upserts.push(entry);
  if (input.target.kind === "ExistingOccurrence") {
    input.preview.existingOccurrencesSet += 1;
  } else {
    input.preview.newPropertiesSet += 1;
  }
  return true;
}

function planSetForFile(
  file: BulkMetadataFileState,
  request: Extract<BulkMetadataDraftRequest, { operation: "Set" }>,
  editValue: MetadataValue,
  preview: BulkMetadataDraftPreview,
): ExactTargetMutationBatchItem | null {
  const occurrences = requireOccurrences(file);
  const storedEntries = validateStoredDrafts(file);
  const schemaId = request.tagInfo.id;
  const authoritative = occurrences.filter((occurrence) =>
    schemaDefinitionIdEquals(occurrence.schema_id, schemaId),
  );
  const sameSchemaDrafts = storedEntries.filter((entry) =>
    schemaDefinitionIdEquals(entry.target.schema_id, schemaId),
  );
  const authoritativeSlots = new Set<string>();
  const existing = authoritative.map((occurrence) => {
    const resolved = existingOccurrenceTargetFromOccurrence(occurrence);
    if (resolved.kind !== "targetable") {
      fail(
        "untargetable-occurrence",
        `${resolved.reason} File: '${file.relativePath}'. Nothing was staged.`,
        file.relativePath,
        schemaId,
      );
    }
    const slot = metadataDraftTargetSlotToken(resolved.target);
    authoritativeSlots.add(slot);
    const owner = file.targetDrafts?.[slot];
    if (owner && !metadataDraftTargetEquals(owner.target, resolved.target)) {
      fail(
        "stale-target-owner",
        `A stale complete target owns an occurrence slot in '${file.relativePath}'. Nothing was staged.`,
        file.relativePath,
        schemaId,
      );
    }
    return { occurrence, target: resolved.target, owner };
  });

  for (const entry of sameSchemaDrafts) {
    if (
      entry.target.kind === "ExistingOccurrence" &&
      !authoritativeSlots.has(metadataDraftTargetSlotToken(entry.target))
    ) {
      fail(
        "stale-existing-draft",
        `An ExistingOccurrence draft for '${file.relativePath}' no longer has its authoritative occurrence. Nothing was staged.`,
        file.relativePath,
        schemaId,
      );
    }
  }

  const stagedNew = sameSchemaDrafts.filter(
    (
      entry,
    ): entry is MetadataTargetDraftEntry & {
      target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>;
    } => entry.target.kind === "NewProperty",
  );
  for (const entry of stagedNew) {
    validateNewPropertyTarget(file, occurrences, entry.target, request.tagInfo);
  }

  const upserts: MetadataTargetDraftEntry[] = [];
  const deletes: MetadataDraftTarget[] = [];
  let changed = false;

  for (const item of existing) {
    const current = effectiveValue(
      file,
      item.occurrence,
      item.owner,
      request.tagInfo,
    );
    const desired = desiredSetValue(
      file,
      request.tagInfo,
      editValue,
      request.merge,
      current,
    );
    changed =
      planTargetSet({
        target: item.target,
        authoritativeValue: item.occurrence.value,
        effectiveValue: current,
        desiredValue: desired,
        owner: item.owner,
        upserts,
        deletes,
        preview,
      }) || changed;
  }

  for (const entry of stagedNew) {
    const current = effectiveValue(file, undefined, entry, request.tagInfo);
    const desired = desiredSetValue(
      file,
      request.tagInfo,
      editValue,
      request.merge,
      current,
    );
    changed =
      planTargetSet({
        target: entry.target,
        authoritativeValue: undefined,
        effectiveValue: current,
        desiredValue: desired,
        owner: entry,
        upserts,
        deletes,
        preview,
      }) || changed;
  }

  if (existing.length === 0 && stagedNew.length === 0) {
    const targetResolution = newPropertyDraftTarget(request.tagInfo);
    if (targetResolution.kind !== "available") {
      fail(
        targetResolution.reason === "read_only_schema"
          ? "read-only-schema"
          : "unsupported-schema-kind",
        `The selected property cannot be created in '${file.relativePath}'. Nothing was staged.`,
        file.relativePath,
        schemaId,
      );
    }
    validateNewPropertyTarget(
      file,
      occurrences,
      targetResolution.target,
      request.tagInfo,
    );
    const desired = desiredSetValue(
      file,
      request.tagInfo,
      editValue,
      request.merge,
      undefined,
    );
    changed =
      planTargetSet({
        target: targetResolution.target,
        authoritativeValue: undefined,
        effectiveValue: undefined,
        desiredValue: desired,
        owner: undefined,
        upserts,
        deletes,
        preview,
      }) || changed;
  }

  return changed ? { path: file.relativePath, upserts, deletes } : null;
}
function gpsGroupIds(group: GpsTagGroup): SchemaDefinitionId[] {
  return [
    group.latitudeId,
    group.latitudeRefId,
    group.longitudeId,
    group.longitudeRefId,
    group.altitudeId,
    group.altitudeRefId,
  ].map((id) => structuredClone(id));
}

function planGpsSetForFile(
  file: BulkMetadataFileState,
  request: Extract<BulkMetadataDraftRequest, { operation: "SetGps" }>,
  preview: BulkMetadataDraftPreview,
): ExactTargetMutationBatchItem | null {
  const occurrences = requireOccurrences(file);
  validateStoredDrafts(file);
  const planned = planGpsTargetDraftBatch(
    request.edits,
    occurrences,
    file.targetDrafts,
  );
  const entries = validateGpsTargetDraftEntries(
    planned.map(({ target, edit }) => ({ target, edit })),
    occurrences,
    file.targetDrafts,
  );
  const upserts: MetadataTargetDraftEntry[] = [];
  const deletes: MetadataDraftTarget[] = [];
  let changed = false;

  for (const entry of entries) {
    if (entry.edit.intent !== "Set" || entry.edit.value === null) {
      fail(
        "invalid-edit",
        "The grouped GPS editor must return non-null Set edits. Nothing was staged.",
        file.relativePath,
        entry.target.schema_id,
      );
    }
    const slot = metadataDraftTargetSlotToken(entry.target);
    const owner = file.targetDrafts?.[slot];
    let occurrence: MetadataOccurrence | undefined;
    if (entry.target.kind === "ExistingOccurrence") {
      const exact = resolveExactMetadataOccurrence(
        occurrences,
        entry.target.occurrence_id,
      );
      if (exact.kind !== "unique") {
        fail(
          "stale-existing-draft",
          "A captured GPS occurrence is no longer uniquely available. Nothing was staged.",
          file.relativePath,
          entry.target.schema_id,
        );
      }
      occurrence = exact.occurrence;
    }
    const current = owner
      ? applyMetadataDraftEditExactly(
          occurrence?.value,
          owner.edit,
          occurrence?.tag_info?.kind,
        )
      : { applied: true as const, value: occurrence?.value };
    if (!current.applied) {
      fail(
        "unpreviewable-draft",
        `A staged GPS edit for '${file.relativePath}' cannot be composed safely: ${current.reason}`,
        file.relativePath,
        entry.target.schema_id,
      );
    }
    changed =
      planTargetSet({
        target: entry.target,
        authoritativeValue: occurrence?.value,
        effectiveValue: current.value,
        desiredValue: entry.edit.value,
        owner,
        upserts,
        deletes,
        preview,
      }) || changed;
  }

  return changed ? { path: file.relativePath, upserts, deletes } : null;
}
function planDeleteForFile(
  file: BulkMetadataFileState,
  schemaIds: readonly SchemaDefinitionId[],
  preview: BulkMetadataDraftPreview,
): ExactTargetMutationBatchItem | null {
  requireOccurrences(file);
  validateStoredDrafts(file);
  const planned = planMetadataRemovalTargets({
    schemaIds,
    occurrences: file.occurrences,
    targetDrafts: file.targetDrafts,
  });
  const affected = planned.upserts.length + planned.deletes.length > 0;
  if (!affected) return null;
  preview.existingOccurrencesDeleted += planned.upserts.length;
  preview.stagedCreationsCancelled += planned.deletes.length;
  return {
    path: file.relativePath,
    upserts: planned.upserts,
    deletes: planned.deletes,
  };
}

/**
 * Plan a complete multi-file operation without mutating any store. Every file
 * is validated before the caller can atomically apply the returned mutations.
 */
export function planBulkMetadataDraftBatch(input: {
  files: readonly BulkMetadataFileState[];
  request: BulkMetadataDraftRequest;
}): BulkMetadataDraftPlan {
  if (input.files.length === 0) {
    fail("empty-selection", "At least one file must be selected.");
  }
  const seenPaths = new Set<string>();
  for (const file of input.files) {
    if (seenPaths.has(file.relativePath)) {
      fail(
        "duplicate-path",
        `The bulk metadata request contains '${file.relativePath}' more than once.`,
        file.relativePath,
      );
    }
    seenPaths.add(file.relativePath);
  }

  const files = structuredClone(Array.from(input.files));
  const request = structuredClone(input.request);
  const preview = emptyPreview(files.length);
  const mutations: ExactTargetMutationBatchItem[] = [];

  switch (request.operation) {
    case "Set": {
      const edit = validateSetRequest(request);
      for (const file of files) {
        const mutation = planSetForFile(file, request, edit.value, preview);
        if (mutation === null) preview.noOpFileCount += 1;
        else {
          preview.affectedFileCount += 1;
          mutations.push(mutation);
        }
      }
      break;
    }
    case "SetGps": {
      for (const file of files) {
        const mutation = planGpsSetForFile(file, request, preview);
        if (mutation === null) preview.noOpFileCount += 1;
        else {
          preview.affectedFileCount += 1;
          mutations.push(mutation);
        }
      }
      break;
    }
    case "Delete":
    case "DeleteGps": {
      const schemaIds =
        request.operation === "Delete"
          ? [request.schemaId]
          : gpsGroupIds(request.group);
      for (const file of files) {
        const mutation = planDeleteForFile(file, schemaIds, preview);
        if (mutation === null) preview.noOpFileCount += 1;
        else {
          preview.affectedFileCount += 1;
          mutations.push(mutation);
        }
      }
      break;
    }
  }

  return {
    mutations: structuredClone(mutations),
    preview: structuredClone(preview),
  };
}

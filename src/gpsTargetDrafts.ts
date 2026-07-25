import type {
  FileMetadataOccurrencesState,
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataTargetDraftEntry,
  SchemaDefinitionId,
} from "./types";
import type { TargetDraftCollection } from "./targetDraftEdits";
import { gpsMemberGroup, type GpsTagGroup } from "./metadata/tag_overrides";
import { knownMetadataWriteTarget } from "./metadata/knownIds";
import { schemaDefinitionIdToken } from "./utils/schemaDefinitionId";
import {
  buildSchemaOccurrenceResolutionIndex,
  findDuplicateMetadataOccurrenceId,
  resolveExactMetadataOccurrence,
  resolutionForSchema,
} from "./utils/metadataOccurrences";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
} from "./utils/metadataDraftTarget";
import {
  metadataWriteSelectorsEqual,
  validateFamily1Group,
} from "./utils/metadataWriteTarget";

export interface MetadataTargetDraftMutation {
  target: MetadataDraftTarget;
  edit: MetadataDraftEdit;
}

export interface PlannedGpsTargetDraft extends MetadataTargetDraftMutation {
  id: SchemaDefinitionId;
}

export type GpsTargetDraftPlanErrorCode =
  | "occurrences-loading"
  | "empty-batch"
  | "duplicate-schema"
  | "duplicate-target-slot"
  | "duplicate-occurrence-id"
  | "ambiguous-staged-target"
  | "stale-staged-target"
  | "non-gps-schema"
  | "mixed-gps-groups"
  | "multiple-occurrences"
  | "untargetable-occurrence"
  | "stale-target"
  | "destination-occupied"
  | "destination-unknown"
  | "selector-collision"
  | "invalid-destination";
/** A user-facing, machine-distinguishable rejection from GPS target handling. */
export class GpsTargetDraftPlanError extends Error {
  constructor(
    readonly code: GpsTargetDraftPlanErrorCode,
    message: string,
    readonly schemaId?: SchemaDefinitionId,
  ) {
    super(message);
    this.name = "GpsTargetDraftPlanError";
  }
}

function gpsGroupToken(group: GpsTagGroup): string {
  return JSON.stringify(
    [
      group.latitudeId,
      group.latitudeRefId,
      group.longitudeId,
      group.longitudeRefId,
      group.altitudeId,
      group.altitudeRefId,
    ].map(schemaDefinitionIdToken),
  );
}

function validateGpsSchemas(
  ids: readonly SchemaDefinitionId[],
  rejectDuplicateSchemas: boolean,
): void {
  const seen = new Set<string>();
  let expectedGroupToken: string | undefined;
  for (const id of ids) {
    const token = schemaDefinitionIdToken(id);
    if (rejectDuplicateSchemas && seen.has(token)) {
      throw new GpsTargetDraftPlanError(
        "duplicate-schema",
        "The GPS batch contains the same exact schema more than once. Nothing was saved.",
        id,
      );
    }
    seen.add(token);
    const group = gpsMemberGroup(id);
    if (group === null) {
      throw new GpsTargetDraftPlanError(
        "non-gps-schema",
        "This action accepts only exact GPS coordinate-group schemas. Nothing was saved.",
        id,
      );
    }
    const currentGroupToken = gpsGroupToken(group);
    if (
      expectedGroupToken !== undefined &&
      expectedGroupToken !== currentGroupToken
    ) {
      throw new GpsTargetDraftPlanError(
        "mixed-gps-groups",
        "Every field in a GPS batch must belong to the same coordinate group. Nothing was saved.",
        id,
      );
    }
    expectedGroupToken = currentGroupToken;
  }
}

/**
 * Schema-oriented target construction boundary used before a fresh GPS editor
 * opens. A planned target is complete and must be preserved for later saving.
 */
export function planGpsTargetDraftBatch(
  edits: readonly {
    id: SchemaDefinitionId;
    edit: MetadataDraftEdit;
  }[],
  occurrences: FileMetadataOccurrencesState,
  targetDrafts?: TargetDraftCollection,
): PlannedGpsTargetDraft[] {
  if (occurrences === "loading") {
    throw new GpsTargetDraftPlanError(
      "occurrences-loading",
      "Authoritative metadata occurrences are still loading. Nothing was saved.",
    );
  }
  if (edits.length === 0) {
    throw new GpsTargetDraftPlanError(
      "empty-batch",
      "A GPS edit must contain at least one field. Nothing was saved.",
    );
  }

  const cloned = structuredClone(edits);
  validateGpsSchemas(
    cloned.map(({ id }) => id),
    true,
  );

  if (findDuplicateMetadataOccurrenceId(occurrences)) {
    throw new GpsTargetDraftPlanError(
      "duplicate-occurrence-id",
      "A complete authoritative metadata occurrence ID is duplicated. The GPS editor was not opened and nothing was saved.",
    );
  }

  const occurrenceIndex = buildSchemaOccurrenceResolutionIndex(occurrences);
  return cloned.map(({ id, edit }) => {
    const occurrenceResolution = resolutionForSchema(occurrenceIndex, id);
    let target: MetadataDraftTarget;
    if (occurrenceResolution.kind === "multiple") {
      throw new GpsTargetDraftPlanError(
        "multiple-occurrences",
        "Several authoritative occurrences share this exact GPS schema, so no occurrence was selected. Nothing was saved.",
        id,
      );
    }
    if (occurrenceResolution.kind === "missing") {
      const stagedTargets = Object.values(targetDrafts ?? {})
        .map((entry) => entry.target)
        .filter(
          (candidate) =>
            schemaDefinitionIdToken(candidate.schema_id) ===
            schemaDefinitionIdToken(id),
        );
      const staleExistingTargets = stagedTargets.filter(
        (candidate) => candidate.kind === "ExistingOccurrence",
      );
      if (staleExistingTargets.length > 0) {
        const message =
          stagedTargets.length > 1
            ? "Several staged targets exist for this missing GPS field, including an ExistingOccurrence draft whose authoritative occurrence no longer exists. The GPS editor was not opened and nothing was saved."
            : "A staged ExistingOccurrence draft no longer has its authoritative occurrence. The GPS editor was not opened and nothing was saved.";
        throw new GpsTargetDraftPlanError("stale-staged-target", message, id);
      }
      if (stagedTargets.length > 1) {
        throw new GpsTargetDraftPlanError(
          "ambiguous-staged-target",
          "Several staged New Property destinations exist for this missing GPS field. The GPS editor was not opened and nothing was saved.",
          id,
        );
      }
      if (stagedTargets.length === 1) {
        target = structuredClone(stagedTargets[0]);
      } else {
        const writeTarget = knownMetadataWriteTarget(id);
        if (!writeTarget) {
          throw new GpsTargetDraftPlanError(
            "non-gps-schema",
            "The exact GPS schema has no registered default write destination. Nothing was saved.",
            id,
          );
        }
        target = {
          kind: "NewProperty",
          schema_id: structuredClone(id),
          write_target: structuredClone(writeTarget),
        };
      }
    } else {
      const targetability = existingOccurrenceTargetFromOccurrence(
        occurrenceResolution.occurrence,
      );
      if (targetability.kind !== "targetable") {
        throw new GpsTargetDraftPlanError(
          "untargetable-occurrence",
          `${targetability.reason} Nothing was saved.`,
          id,
        );
      }
      target = targetability.target;
    }
    return { id: structuredClone(id), target, edit: structuredClone(edit) };
  });
}
/**
 * Validate already-captured GPS targets against current authoritative state.
 * No schema-based target selection or destination replacement occurs here.
 */
export function validateGpsTargetDraftEntries(
  entries: readonly MetadataTargetDraftMutation[],
  occurrences: FileMetadataOccurrencesState,
  targetDrafts: TargetDraftCollection | undefined,
): MetadataTargetDraftEntry[] {
  if (occurrences === "loading") {
    throw new GpsTargetDraftPlanError(
      "occurrences-loading",
      "Authoritative metadata occurrences are still loading. Nothing was saved.",
    );
  }
  if (entries.length === 0) {
    throw new GpsTargetDraftPlanError(
      "empty-batch",
      "A GPS edit must contain at least one field. Nothing was saved.",
    );
  }

  const cloned: MetadataTargetDraftEntry[] = entries.map((entry) =>
    structuredClone(entry),
  );
  validateGpsSchemas(
    cloned.map(({ target }) => target.schema_id),
    false,
  );
  const seenSlots = new Set<string>();
  const seenSelectors: MetadataDraftTarget[] = [];
  for (const { target } of cloned) {
    const slot = metadataDraftTargetSlotToken(target);
    if (seenSlots.has(slot)) {
      throw new GpsTargetDraftPlanError(
        "duplicate-target-slot",
        "The GPS batch contains the same exact target slot more than once. Nothing was saved.",
        target.schema_id,
      );
    }
    seenSlots.add(slot);
    if (
      seenSelectors.some((other) =>
        metadataWriteSelectorsEqual(other.write_target, target.write_target),
      )
    ) {
      throw new GpsTargetDraftPlanError(
        "selector-collision",
        "Two incoming GPS targets resolve to the same ExifTool destination. Nothing was saved.",
        target.schema_id,
      );
    }
    seenSelectors.push(target);

    const stored = targetDrafts?.[slot];
    if (stored && !metadataDraftTargetEquals(stored.target, target)) {
      throw new GpsTargetDraftPlanError(
        "stale-target",
        "The exact GPS target slot is owned by a different complete target snapshot. Nothing was saved.",
        target.schema_id,
      );
    }

    if (target.kind === "ExistingOccurrence") {
      const exact = resolveExactMetadataOccurrence(
        occurrences,
        target.occurrence_id,
      );
      if (exact.kind !== "unique") {
        throw new GpsTargetDraftPlanError(
          "stale-target",
          exact.kind === "duplicate"
            ? "The exact GPS occurrence ID is duplicated. Nothing was saved."
            : "The exact GPS occurrence no longer exists. Nothing was saved.",
          target.schema_id,
        );
      }
      const current = existingOccurrenceTargetFromOccurrence(exact.occurrence);
      if (
        current.kind !== "targetable" ||
        !metadataDraftTargetEquals(current.target, target)
      ) {
        throw new GpsTargetDraftPlanError(
          "stale-target",
          "The captured GPS occurrence target no longer matches authoritative state. Nothing was saved.",
          target.schema_id,
        );
      }
      continue;
    }

    const defaultTarget = knownMetadataWriteTarget(target.schema_id);
    if (
      !defaultTarget ||
      defaultTarget.group7 !== target.write_target.group7 ||
      defaultTarget.tag_name !== target.write_target.tag_name ||
      validateFamily1Group(target.write_target.group1) !== null
    ) {
      throw new GpsTargetDraftPlanError(
        "invalid-destination",
        "The captured GPS destination is no longer eligible. Nothing was saved.",
        target.schema_id,
      );
    }
    if (
      occurrences.some(
        (occurrence) =>
          occurrence.observed_selector !== null &&
          metadataWriteSelectorsEqual(
            occurrence.observed_selector,
            target.write_target,
          ),
      )
    ) {
      throw new GpsTargetDraftPlanError(
        "destination-occupied",
        "The captured GPS destination is already occupied. Nothing was saved.",
        target.schema_id,
      );
    }
    if (
      occurrences.some(
        (occurrence) =>
          occurrence.observed_selector === null &&
          schemaDefinitionIdToken(occurrence.schema_id) ===
            schemaDefinitionIdToken(target.schema_id),
      )
    ) {
      throw new GpsTargetDraftPlanError(
        "destination-unknown",
        "A same-schema GPS occurrence has no safely identifiable destination. Nothing was saved.",
        target.schema_id,
      );
    }
    const selectorCollision = Object.entries(targetDrafts ?? {}).some(
      ([otherSlot, entry]) =>
        otherSlot !== slot &&
        metadataWriteSelectorsEqual(
          entry.target.write_target,
          target.write_target,
        ),
    );
    if (selectorCollision) {
      throw new GpsTargetDraftPlanError(
        "selector-collision",
        "Another exact draft target uses the captured GPS selector. Nothing was saved.",
        target.schema_id,
      );
    }
  }

  return cloned;
}

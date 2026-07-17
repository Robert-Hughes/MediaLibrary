import type {
  ImageMetadataOccurrencesState,
  MetadataDraftEdit,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "./types";
import type { TargetDraftCollection } from "./targetDraftEdits";
import { gpsMemberGroup, type GpsTagGroup } from "./metadata/tag_overrides";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
import {
  buildSchemaOccurrenceResolutionIndex,
  resolutionForSchema,
} from "./utils/metadataOccurrences";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./utils/metadataDraftTarget";

export interface PlannedGpsTargetDraftV5 {
  id: SchemaDefinitionId;
  target: MetadataDraftTarget;
  edit: MetadataDraftEdit;
}

export type GpsTargetDraftPlanErrorCode =
  | "occurrences-loading"
  | "empty-batch"
  | "duplicate-schema"
  | "non-gps-schema"
  | "mixed-gps-groups"
  | "multiple-occurrences"
  | "untargetable-occurrence"
  | "multiple-target-owners"
  | "incompatible-target-owner";

/** A user-facing, machine-distinguishable rejection from the pure GPS planner. */
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

/**
 * Plans one exact, target-aware GPS batch without mutating inputs or stores.
 * Every rejection happens before a result is returned to the caller.
 */
export function planGpsTargetDraftBatchV5(
  edits: readonly {
    id: SchemaDefinitionId;
    edit: MetadataDraftEdit;
  }[],
  occurrences: ImageMetadataOccurrencesState,
  targetDrafts: TargetDraftCollection | undefined,
): PlannedGpsTargetDraftV5[] {
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

  const cloned = edits.map(({ id, edit }) => ({
    id: structuredClone(id),
    edit: structuredClone(edit),
  }));
  const seen = new Set<string>();
  let expectedGroupToken: string | undefined;
  for (const { id } of cloned) {
    const token = schemaDefinitionIdToken(id);
    if (seen.has(token)) {
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
    const tokenForGroup = gpsGroupToken(group);
    if (
      expectedGroupToken !== undefined &&
      expectedGroupToken !== tokenForGroup
    ) {
      throw new GpsTargetDraftPlanError(
        "mixed-gps-groups",
        "Every field in a GPS batch must belong to the same coordinate group. Nothing was saved.",
        id,
      );
    }
    expectedGroupToken = tokenForGroup;
  }

  const occurrenceIndex = buildSchemaOccurrenceResolutionIndex(occurrences);
  const planned: PlannedGpsTargetDraftV5[] = [];
  for (const { id, edit } of cloned) {
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
      target = {
        kind: "NewProperty",
        schema_id: structuredClone(id),
      };
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

    const owners = Object.values(targetDrafts ?? {}).filter((entry) =>
      schemaDefinitionIdEquals(entry.target.schema_id, id),
    );
    if (owners.length > 1) {
      throw new GpsTargetDraftPlanError(
        "multiple-target-owners",
        "Multiple target-aware operations own this exact GPS schema. Apply or discard them before editing. Nothing was saved.",
        id,
      );
    }
    if (
      owners.length === 1 &&
      !metadataDraftTargetEquals(owners[0].target, target)
    ) {
      throw new GpsTargetDraftPlanError(
        "incompatible-target-owner",
        "A different target-aware destination owns this exact GPS schema. Apply or discard it before editing. Nothing was saved.",
        id,
      );
    }

    planned.push({
      id: structuredClone(id),
      target: structuredClone(target),
      edit: structuredClone(edit),
    });
  }

  return planned;
}

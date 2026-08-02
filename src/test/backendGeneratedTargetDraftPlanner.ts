import { KNOWN_METADATA_IDS } from "../metadata/knownIds";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { metadataTargetDraftEntryEqualsExact } from "../targetDraftEdits";
import {
  GEOCODE_TARGET_TAGS,
  metadataValueEqual,
  NORMALISE_TARGET_TAGS_BY_GROUP,
} from "../types";
import type {
  FileMetadataOccurrencesState,
  SchemaMetadataEdit,
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  NormaliseGroup,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
  newPropertyDraftTarget,
} from "../utils/metadataDraftTarget";
import {
  declaredGeneratedMetadataDestination,
  occurrencesAtDeclaredDestination,
} from "../utils/generatedMetadataDestination";
import { metadataWriteSelectorsEqual } from "../utils/metadataWriteTarget";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";
import { tagInfoSupportsMetadataWrite } from "../utils/metadataWriteSupport";
export type GeneratedMetadataProducer =
  | { kind: "describe" }
  | { kind: "geocode" }
  | {
      kind: "normalise";
      enabledGroups: readonly NormaliseGroup[];
    };

export interface GeneratedTargetDraftPlan {
  upserts: MetadataTargetDraftEntry[];
  deletes: MetadataDraftTarget[];
  noops: SchemaDefinitionId[];
}

export type GeneratedDraftStageResult =
  { kind: "success"; changed: boolean } | { kind: "failure"; reason: string };
export type GeneratedTargetDraftPlanErrorCode =
  | "occurrences_loading"
  | "invalid_entry"
  | "duplicate_schema"
  | "schema_not_allowed"
  | "intent_not_allowed"
  | "schema_definition_missing"
  | "multiple_occurrences"
  | "occurrence_not_targetable"
  | "target_owner_mismatch";

export class GeneratedTargetDraftPlanError extends Error {
  readonly name = "GeneratedTargetDraftPlanError";

  constructor(
    readonly code: GeneratedTargetDraftPlanErrorCode,
    message: string,
    readonly schemaId?: SchemaDefinitionId,
  ) {
    super(message);
  }
}

export const DESCRIBE_TARGET_TAGS: readonly SchemaDefinitionId[] = [
  KNOWN_METADATA_IDS.mlibAiDescription,
  KNOWN_METADATA_IDS.mlibAiInterpretation,
  KNOWN_METADATA_IDS.mlibAiTags,
  KNOWN_METADATA_IDS.mlibAiObjects,
  KNOWN_METADATA_IDS.mlibAiOcrText,
  KNOWN_METADATA_IDS.mlibAiModel,
  KNOWN_METADATA_IDS.mlibAiPromptVersion,
  KNOWN_METADATA_IDS.mlibAiGeneratedAt,
] as const;

function fail(
  code: GeneratedTargetDraftPlanErrorCode,
  message: string,
  schemaId?: SchemaDefinitionId,
): never {
  throw new GeneratedTargetDraftPlanError(
    code,
    message,
    schemaId === undefined ? undefined : structuredClone(schemaId),
  );
}

function producerName(producer: GeneratedMetadataProducer): string {
  switch (producer.kind) {
    case "describe":
      return "AI description";
    case "geocode":
      return "reverse geocode";
    case "normalise":
      return "metadata normalisation";
  }
}

function allowedSchemaTokens(
  producer: GeneratedMetadataProducer,
): ReadonlySet<string> {
  if (producer.kind === "describe") {
    return new Set(DESCRIBE_TARGET_TAGS.map(schemaDefinitionIdToken));
  }
  if (producer.kind === "geocode") {
    return new Set(GEOCODE_TARGET_TAGS.map(schemaDefinitionIdToken));
  }
  return new Set(
    producer.enabledGroups.flatMap((group) =>
      NORMALISE_TARGET_TAGS_BY_GROUP[group].map(schemaDefinitionIdToken),
    ),
  );
}

function intentAllowed(
  producer: GeneratedMetadataProducer,
  intent: SchemaMetadataEdit["edit"]["intent"],
): boolean {
  if (producer.kind === "describe") return intent === "Set";
  // Reverse geocoding deliberately emits Delete for absent members of its
  // coherent ten-field replacement set; normalisation also emits Set/Delete.
  return intent === "Set" || intent === "Delete";
}
function clonePlan(plan: GeneratedTargetDraftPlan): GeneratedTargetDraftPlan {
  return {
    upserts: plan.upserts.map((entry) => structuredClone(entry)),
    deletes: plan.deletes.map((target) => structuredClone(target)),
    noops: plan.noops.map((id) => structuredClone(id)),
  };
}

/**
 * Convert one complete backend-generated semantic edit batch into exact
 * target mutations. The function is pure and never chooses an occurrence
 * heuristically.
 */
export function planGeneratedTargetDraftBatch(input: {
  producer: GeneratedMetadataProducer;
  fileName: string;
  edits: readonly SchemaMetadataEdit[];
  occurrences: FileMetadataOccurrencesState;
  targetDrafts: TargetDraftCollection | undefined;
  writableSchemaDefinitions: readonly TagInfo[];
}): GeneratedTargetDraftPlan {
  if (input.edits.length === 0) {
    return {
      upserts: [],
      deletes: [],
      noops: [],
    };
  }

  if (!Array.isArray(input.occurrences)) {
    fail(
      "occurrences_loading",
      "Authoritative metadata occurrences are still loading for this file.",
    );
  }

  const allowed = allowedSchemaTokens(input.producer);
  const seen = new Set<string>();
  for (const candidate of input.edits) {
    const token = schemaDefinitionIdToken(candidate.schema_id);
    if (seen.has(token)) {
      fail(
        "duplicate_schema",
        `The generated batch contains the same exact schema more than once: ${token}.`,
        candidate.schema_id,
      );
    }
    seen.add(token);
    if (!allowed.has(token)) {
      fail(
        "schema_not_allowed",
        `${producerName(input.producer)} is not allowed to generate exact schema ${token}.`,
        candidate.schema_id,
      );
    }
    if (
      (candidate.edit.intent === "Set" && candidate.edit.value === null) ||
      (candidate.edit.intent === "Delete" && candidate.edit.value !== null)
    ) {
      fail(
        "invalid_entry",
        `Generated ${candidate.edit.intent} edit for ${token} has an invalid semantic value payload.`,
        candidate.schema_id,
      );
    }
    if (!intentAllowed(input.producer, candidate.edit.intent)) {
      fail(
        "intent_not_allowed",
        `${producerName(input.producer)} does not support generated ${candidate.edit.intent} edits for ${token}.`,
        candidate.schema_id,
      );
    }
  }

  // Clone the complete validated input before any target resolution so callers
  // cannot mutate IDs, edits or owner snapshots while a plan is being built.
  const edits = structuredClone(Array.from(input.edits));
  const occurrences = structuredClone(input.occurrences);
  const targetDrafts =
    input.targetDrafts === undefined
      ? undefined
      : structuredClone(input.targetDrafts);

  const plan: GeneratedTargetDraftPlan = {
    upserts: [],
    deletes: [],
    noops: [],
  };

  for (const entry of edits) {
    const schemaId = entry.schema_id;
    const token = schemaDefinitionIdToken(schemaId);

    const declaredDestination = declaredGeneratedMetadataDestination(schemaId);
    if (declaredDestination === null) {
      fail(
        "schema_definition_missing",
        `No declared generated-metadata destination is available for ${token}.`,
        schemaId,
      );
    }
    const destinationOccurrences = occurrencesAtDeclaredDestination(
      occurrences,
      schemaId,
      declaredDestination,
    );
    const sameSchemaOccurrences = occurrences.filter((candidate) =>
      schemaDefinitionIdEquals(candidate.schema_id, schemaId),
    );
    if (
      destinationOccurrences.length === 0 &&
      sameSchemaOccurrences.some(
        (candidate) => candidate.observed_selector === null,
      )
    ) {
      fail(
        "occurrence_not_targetable",
        `An authoritative occurrence for ${token} has no physical selector, so its declared destination cannot be resolved safely.`,
        schemaId,
      );
    }
    if (destinationOccurrences.length > 1) {
      fail(
        "multiple_occurrences",
        `Exact schema ${token} resolves to multiple authoritative occurrences at its declared destination; no occurrence was selected.`,
        schemaId,
      );
    }
    const occurrence =
      destinationOccurrences.length === 0
        ? ({ kind: "missing" } as const)
        : ({
            kind: "unique",
            occurrence: destinationOccurrences[0],
          } as const);

    const tagInfo =
      occurrence.kind === "unique"
        ? occurrence.occurrence.tag_info
        : input.writableSchemaDefinitions.find(
            (candidate) => schemaDefinitionIdToken(candidate.id) === token,
          );
    if (!tagInfo) {
      fail(
        "schema_definition_missing",
        `No exact writable schema definition is available for ${token}.`,
        schemaId,
      );
    }
    const formatIncompatibleSet =
      entry.edit.intent === "Set" &&
      tagInfoSupportsMetadataWrite(tagInfo, input.fileName, "DeleteExisting") &&
      !tagInfoSupportsMetadataWrite(tagInfo, input.fileName, "Set");

    let plannedTarget: MetadataDraftTarget;
    if (occurrence.kind === "missing") {
      const target = newPropertyDraftTarget(tagInfo);
      if (target.kind !== "available") {
        fail(
          "schema_definition_missing",
          `Exact schema ${token} cannot be used as a new writable property (${target.reason}).`,
          schemaId,
        );
      }
      if (
        !metadataWriteSelectorsEqual(
          target.target.write_target,
          declaredDestination,
        )
      ) {
        fail(
          "schema_definition_missing",
          `Exact schema ${token} does not resolve to its declared generated-metadata destination.`,
          schemaId,
        );
      }
      plannedTarget = target.target;
    } else {
      const target = existingOccurrenceTargetFromOccurrence(
        occurrence.occurrence,
      );
      if (target.kind !== "targetable") {
        fail(
          "occurrence_not_targetable",
          `The authoritative occurrence for ${token} cannot be targeted safely: ${target.reason}`,
          schemaId,
        );
      }
      plannedTarget = target.target;
    }

    const plannedSlot = metadataDraftTargetSlotToken(plannedTarget);
    const slotOwner = targetDrafts?.[plannedSlot];
    if (
      slotOwner !== undefined &&
      !metadataDraftTargetEquals(slotOwner.target, plannedTarget)
    ) {
      fail(
        "target_owner_mismatch",
        `The stored owner of the planned target slot for ${token} has a stale target snapshot.`,
        schemaId,
      );
    }
    const owner = slotOwner;

    if (formatIncompatibleSet) {
      if (owner === undefined) {
        plan.noops.push(structuredClone(schemaId));
      } else {
        plan.deletes.push(structuredClone(plannedTarget));
      }
      continue;
    }

    if (occurrence.kind === "missing" && entry.edit.intent === "Delete") {
      if (owner === undefined) {
        plan.noops.push(structuredClone(schemaId));
      } else {
        plan.deletes.push(structuredClone(plannedTarget));
      }
      continue;
    }

    if (
      plannedTarget.kind === "ExistingOccurrence" &&
      entry.edit.intent === "Set" &&
      metadataValueEqual(
        occurrence.kind === "unique" ? occurrence.occurrence.value : undefined,
        entry.edit.value ?? undefined,
      )
    ) {
      if (owner !== undefined) {
        plan.deletes.push(structuredClone(plannedTarget));
      } else {
        plan.noops.push(structuredClone(schemaId));
      }
      continue;
    }

    const plannedEntry: MetadataTargetDraftEntry = {
      target: structuredClone(plannedTarget),
      edit: structuredClone(entry.edit),
    };
    if (
      owner !== undefined &&
      metadataTargetDraftEntryEqualsExact(owner, plannedEntry)
    ) {
      plan.noops.push(structuredClone(schemaId));
      continue;
    }

    plan.upserts.push(plannedEntry);
  }

  return clonePlan(plan);
}

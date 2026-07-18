import {
  KNOWN_METADATA_IDS,
  knownMetadataWriteTarget,
} from "./metadata/knownIds";
import type { TargetDraftCollection } from "./targetDraftEdits";
import { metadataTargetDraftEntryEqualsExact } from "./targetDraftEdits";
import {
  GEOCODE_TARGET_TAGS,
  metadataValueEqual,
  NORMALISE_TARGET_TAGS_BY_GROUP,
} from "./types";
import type {
  ImageMetadataOccurrencesState,
  SchemaMetadataEdit,
  MetadataTargetDraftEntry,
  MetadataDraftTarget,
  NormaliseGroup,
  SchemaDefinitionId,
} from "./types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
  metadataDraftTargetSlotToken,
} from "./utils/metadataDraftTarget";
import { resolveOccurrencesForSchema } from "./utils/metadataOccurrences";
import {
  isMetadataDraftEdit,
  isRecord,
  isSchemaDefinitionId,
} from "./utils/metadataWireGuards";
import { schemaDefinitionIdToken } from "./utils/schemaDefinitionId";
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
  edits: readonly SchemaMetadataEdit[];
  occurrences: ImageMetadataOccurrencesState;
  targetDrafts: TargetDraftCollection | undefined;
}): GeneratedTargetDraftPlan {
  if (input.edits.length === 0) {
    return {
      upserts: [],
      deletes: [],
      noops: [],
    };
  }

  if (input.occurrences === "loading") {
    fail(
      "occurrences_loading",
      "Authoritative metadata occurrences are still loading for this file.",
    );
  }

  const allowed = allowedSchemaTokens(input.producer);
  const seen = new Set<string>();
  for (const [index, candidate] of input.edits.entries()) {
    if (
      !isRecord(candidate) ||
      !isSchemaDefinitionId(candidate.schema_id) ||
      !isMetadataDraftEdit(candidate.edit)
    ) {
      fail(
        "invalid_entry",
        `Generated metadata entry ${index + 1} is not a valid semantic edit entry.`,
      );
    }
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

    const occurrence = resolveOccurrencesForSchema(occurrences, schemaId);
    if (occurrence.kind === "multiple") {
      fail(
        "multiple_occurrences",
        `Exact schema ${token} resolves to multiple authoritative occurrences; no occurrence was selected.`,
        schemaId,
      );
    }

    let plannedTarget: MetadataDraftTarget;
    if (occurrence.kind === "missing") {
      const writeTarget = knownMetadataWriteTarget(schemaId);
      if (!writeTarget) {
        fail(
          "schema_not_allowed",
          `No exact default write destination is registered for ${token}.`,
          schemaId,
        );
      }
      plannedTarget = {
        kind: "NewProperty",
        schema_id: structuredClone(schemaId),
        write_target: writeTarget,
      };
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

import { KNOWN_METADATA_IDS } from "./metadata/knownIds";
import type { TargetDraftCollection } from "./targetDraftEdits";
import { metadataDraftEntryV5EqualsExact } from "./targetDraftEdits";
import { resolveTargetDraftByExactSchema } from "./targetDraftView";
import {
  GEOCODE_TARGET_TAGS,
  metadataValueEqual,
  NORMALISE_TARGET_TAGS_BY_GROUP,
} from "./types";
import type {
  ImageMetadataOccurrencesState,
  MetadataDraftCollection,
  MetadataDraftEntry,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  NormaliseGroup,
  SchemaDefinitionId,
} from "./types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetEquals,
} from "./utils/metadataDraftTarget";
import { resolveOccurrencesForSchema } from "./utils/metadataOccurrences";
import {
  isMetadataDraftEdit,
  isRecord,
  isSchemaDefinitionId,
} from "./utils/metadataWireGuards";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./utils/schemaDefinitionId";
export type GeneratedMetadataProducerV5 =
  | { kind: "describe" }
  | { kind: "geocode" }
  | {
      kind: "normalise";
      enabledGroups: readonly NormaliseGroup[];
    };

export interface GeneratedTargetDraftPlanV5 {
  upserts: MetadataDraftEntryV5[];
  deletes: MetadataDraftTarget[];
  noops: SchemaDefinitionId[];
}

export type GeneratedDraftStageResultV5 =
  { kind: "success"; changed: boolean } | { kind: "failure"; reason: string };
export type GeneratedTargetDraftPlanErrorCode =
  | "occurrences_loading"
  | "invalid_entry"
  | "duplicate_schema"
  | "schema_not_allowed"
  | "intent_not_allowed"
  | "multiple_occurrences"
  | "occurrence_not_targetable"
  | "legacy_owner"
  | "multiple_target_owners"
  | "target_owner_mismatch"
  | "stale_target_owner";

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

function producerName(producer: GeneratedMetadataProducerV5): string {
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
  producer: GeneratedMetadataProducerV5,
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
  producer: GeneratedMetadataProducerV5,
  intent: MetadataDraftEntry["edit"]["intent"],
): boolean {
  if (producer.kind === "describe") return intent === "Set";
  // Reverse geocoding deliberately emits Delete for absent members of its
  // coherent ten-field replacement set; normalisation also emits Set/Delete.
  return intent === "Set" || intent === "Delete";
}
function exactLegacyOwner(
  drafts: MetadataDraftCollection | undefined,
  schemaId: SchemaDefinitionId,
): boolean {
  return Object.values(drafts ?? {}).some((entry) =>
    schemaDefinitionIdEquals(entry.id, schemaId),
  );
}

function clonePlan(
  plan: GeneratedTargetDraftPlanV5,
): GeneratedTargetDraftPlanV5 {
  return {
    upserts: plan.upserts.map((entry) => structuredClone(entry)),
    deletes: plan.deletes.map((target) => structuredClone(target)),
    noops: plan.noops.map((id) => structuredClone(id)),
  };
}

/**
 * Convert one complete backend-generated schema-keyed batch into exact v5
 * target mutations. The function is pure and never chooses an occurrence
 * heuristically.
 */
export function planGeneratedTargetDraftBatchV5(input: {
  producer: GeneratedMetadataProducerV5;
  edits: readonly MetadataDraftEntry[];
  occurrences: ImageMetadataOccurrencesState;
  legacyDrafts: MetadataDraftCollection | undefined;
  targetDrafts: TargetDraftCollection | undefined;
}): GeneratedTargetDraftPlanV5 {
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
      !isSchemaDefinitionId(candidate.id) ||
      !isMetadataDraftEdit(candidate.edit)
    ) {
      fail(
        "invalid_entry",
        `Generated metadata entry ${index + 1} is not a valid schema-keyed semantic draft entry.`,
      );
    }
    const token = schemaDefinitionIdToken(candidate.id);
    if (seen.has(token)) {
      fail(
        "duplicate_schema",
        `The generated batch contains the same exact schema more than once: ${token}.`,
        candidate.id,
      );
    }
    seen.add(token);
    if (!allowed.has(token)) {
      fail(
        "schema_not_allowed",
        `${producerName(input.producer)} is not allowed to generate exact schema ${token}.`,
        candidate.id,
      );
    }
    if (
      (candidate.edit.intent === "Set" && candidate.edit.value === null) ||
      (candidate.edit.intent === "Delete" && candidate.edit.value !== null)
    ) {
      fail(
        "invalid_entry",
        `Generated ${candidate.edit.intent} edit for ${token} has an invalid semantic value payload.`,
        candidate.id,
      );
    }
    if (!intentAllowed(input.producer, candidate.edit.intent)) {
      fail(
        "intent_not_allowed",
        `${producerName(input.producer)} does not support generated ${candidate.edit.intent} edits for ${token}.`,
        candidate.id,
      );
    }
  }

  // Clone the complete validated input before any target resolution so callers
  // cannot mutate IDs, edits or owner snapshots while a plan is being built.
  const edits = structuredClone(Array.from(input.edits));
  const occurrences = structuredClone(input.occurrences);
  const legacyDrafts =
    input.legacyDrafts === undefined
      ? undefined
      : structuredClone(input.legacyDrafts);
  const targetDrafts =
    input.targetDrafts === undefined
      ? undefined
      : structuredClone(input.targetDrafts);

  const plan: GeneratedTargetDraftPlanV5 = {
    upserts: [],
    deletes: [],
    noops: [],
  };

  for (const entry of edits) {
    const schemaId = entry.id;
    const token = schemaDefinitionIdToken(schemaId);

    if (exactLegacyOwner(legacyDrafts, schemaId)) {
      fail(
        "legacy_owner",
        `A persisted legacy draft already owns ${token}. Apply or discard the legacy draft before generating this field.`,
        schemaId,
      );
    }

    const owner = resolveTargetDraftByExactSchema(targetDrafts, schemaId);
    if (owner.kind === "ambiguous") {
      fail(
        "multiple_target_owners",
        `Multiple target-aware drafts own ${token}; no generated target was selected.`,
        schemaId,
      );
    }

    const occurrence = resolveOccurrencesForSchema(occurrences, schemaId);
    if (occurrence.kind === "multiple") {
      fail(
        "multiple_occurrences",
        `Exact schema ${token} resolves to multiple authoritative occurrences; no occurrence was selected.`,
        schemaId,
      );
    }

    if (occurrence.kind === "missing" && entry.edit.intent === "Delete") {
      if (owner.kind === "missing") {
        plan.noops.push(structuredClone(schemaId));
        continue;
      }
      if (owner.entry.target.kind === "NewProperty") {
        plan.deletes.push(structuredClone(owner.entry.target));
        continue;
      }
      fail(
        "stale_target_owner",
        `An ExistingOccurrence draft owns missing schema ${token}; apply or discard the stale target-aware draft first.`,
        schemaId,
      );
    }

    let plannedTarget: MetadataDraftTarget;
    if (occurrence.kind === "missing") {
      plannedTarget = {
        kind: "NewProperty",
        schema_id: structuredClone(schemaId),
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

    if (
      owner.kind === "unique" &&
      !metadataDraftTargetEquals(owner.entry.target, plannedTarget)
    ) {
      const variantMismatch = owner.entry.target.kind !== plannedTarget.kind;
      fail(
        "target_owner_mismatch",
        variantMismatch
          ? `The existing target-aware owner for ${token} uses a different target variant.`
          : `The existing target-aware owner for ${token} points at a different occurrence or stale runtime selector snapshot.`,
        schemaId,
      );
    }

    if (
      plannedTarget.kind === "ExistingOccurrence" &&
      entry.edit.intent === "Set" &&
      metadataValueEqual(
        occurrence.kind === "unique" ? occurrence.occurrence.value : undefined,
        entry.edit.value ?? undefined,
      )
    ) {
      if (owner.kind === "unique") {
        plan.deletes.push(structuredClone(owner.entry.target));
      } else {
        plan.noops.push(structuredClone(schemaId));
      }
      continue;
    }

    const plannedEntry: MetadataDraftEntryV5 = {
      target: structuredClone(plannedTarget),
      edit: structuredClone(entry.edit),
    };
    if (
      owner.kind === "unique" &&
      metadataDraftEntryV5EqualsExact(owner.entry, plannedEntry)
    ) {
      plan.noops.push(structuredClone(schemaId));
      continue;
    }

    plan.upserts.push(plannedEntry);
  }

  return clonePlan(plan);
}

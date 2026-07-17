import type {
  ImageMetadataOccurrencesState,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  compareMetadataOccurrenceIds,
  metadataOccurrenceIdEquals,
} from "./metadataOccurrenceId";
import {
  compareSchemaDefinitionIds,
  schemaDefinitionIdEquals,
} from "./schemaDefinitionId";
import { resolveExactMetadataOccurrence } from "./metadataOccurrences";

type ExistingOccurrenceDraftTarget = Extract<
  MetadataDraftTarget,
  { kind: "ExistingOccurrence" }
>;

type NewPropertyDraftTarget = Extract<
  MetadataDraftTarget,
  { kind: "NewProperty" }
>;

export type ExistingOccurrenceDraftTargetResolution =
  | {
      kind: "available";
      target: ExistingOccurrenceDraftTarget;
    }
  | {
      kind: "unavailable";
      reason:
        | "unknown_schema"
        | "schema_mismatch"
        | "read_only_schema"
        | "missing_write_target";
    };

export type ExistingOccurrenceTargetResolution =
  | {
      kind: "targetable";
      target: ExistingOccurrenceDraftTarget;
    }
  | {
      kind: "read-only";
      reason: string;
    };

export type NewPropertyDraftTargetResolution =
  | {
      kind: "available";
      target: NewPropertyDraftTarget;
    }
  | {
      kind: "unavailable";
      reason: "read_only_schema";
    };

/** Returns the exact schema identity carried by either target variant. */
export function metadataDraftTargetSchemaId(
  target: MetadataDraftTarget,
): SchemaDefinitionId {
  return target.schema_id;
}

/**
 * Identifies the complete stored target snapshot. This internal JavaScript
 * token must never be persisted or sent through Tauri.
 */
export function metadataDraftTargetToken(target: MetadataDraftTarget): string {
  const schema = [
    target.schema_id.table,
    target.schema_id.tag_id,
    target.schema_id.index ?? null,
  ];

  if (target.kind === "NewProperty") {
    return JSON.stringify(["NewProperty", schema]);
  }

  return JSON.stringify([
    "ExistingOccurrence",
    [
      target.occurrence_id.document ?? null,
      target.occurrence_id.path,
      target.occurrence_id.tag_id,
      target.occurrence_id.copy,
    ],
    schema,
    [target.write_target.group1, target.write_target.tag_name],
  ]);
}

/**
 * Identifies which one logical draft position a complete target snapshot
 * occupies. This token is only for future draft-map collection mechanics and
 * must never be persisted or sent through Tauri.
 */
export function metadataDraftTargetSlotToken(
  target: MetadataDraftTarget,
): string {
  if (target.kind === "NewProperty") {
    return JSON.stringify([
      "NewProperty",
      [
        target.schema_id.table,
        target.schema_id.tag_id,
        target.schema_id.index ?? null,
      ],
    ]);
  }

  return JSON.stringify([
    "ExistingOccurrence",
    [
      target.occurrence_id.document ?? null,
      target.occurrence_id.path,
      target.occurrence_id.tag_id,
      target.occurrence_id.copy,
    ],
  ]);
}

/** Ordering matching Rust's derived `MetadataDraftSlot::Ord`. */
export function compareMetadataDraftTargetsBySlot(
  left: MetadataDraftTarget,
  right: MetadataDraftTarget,
): number {
  if (left.kind === "ExistingOccurrence") {
    if (right.kind === "NewProperty") return -1;
    return compareMetadataOccurrenceIds(
      left.occurrence_id,
      right.occurrence_id,
    );
  }

  if (right.kind === "ExistingOccurrence") return 1;
  return compareSchemaDefinitionIds(left.schema_id, right.schema_id);
}

export function metadataDraftTargetEquals(
  left: MetadataDraftTarget,
  right: MetadataDraftTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (!schemaDefinitionIdEquals(left.schema_id, right.schema_id)) return false;

  if (left.kind === "NewProperty") return true;
  if (right.kind === "NewProperty") return false;

  return (
    metadataOccurrenceIdEquals(left.occurrence_id, right.occurrence_id) &&
    left.write_target.group1 === right.write_target.group1 &&
    left.write_target.tag_name === right.write_target.tag_name
  );
}

/**
 * Captures one explicitly selected occurrence. This helper never resolves a
 * schema to an occurrence or selects from an ambiguous resolution.
 */
export function existingOccurrenceDraftTarget(
  occurrence: MetadataOccurrence,
): ExistingOccurrenceDraftTargetResolution {
  const resolution = existingOccurrenceTargetFromOccurrence(occurrence);
  if (resolution.kind === "targetable") {
    return { kind: "available", target: resolution.target };
  }

  const info = occurrence.tag_info;
  if (info == null) {
    return { kind: "unavailable", reason: "unknown_schema" };
  }
  if (!schemaDefinitionIdEquals(info.id, occurrence.schema_id)) {
    return { kind: "unavailable", reason: "schema_mismatch" };
  }
  if (!info.writable) {
    return { kind: "unavailable", reason: "read_only_schema" };
  }
  if (occurrence.write_target == null) {
    return { kind: "unavailable", reason: "missing_write_target" };
  }

  throw new Error("Unreachable targetability state");
}

/**
 * Builds a complete target snapshot from one authoritative occurrence.
 * Nothing in this boundary infers runtime identity from schema identity.
 */
export function existingOccurrenceTargetFromOccurrence(
  occurrence: MetadataOccurrence,
): ExistingOccurrenceTargetResolution {
  if (occurrence.tag_info === null) {
    return {
      kind: "read-only",
      reason:
        "This occurrence has no exact TagInfo and cannot be edited safely.",
    };
  }
  if (!schemaDefinitionIdEquals(occurrence.tag_info.id, occurrence.schema_id)) {
    return {
      kind: "read-only",
      reason:
        "This occurrence's exact schema ID conflicts with its TagInfo and cannot be edited safely.",
    };
  }
  if (!occurrence.tag_info.writable) {
    return {
      kind: "read-only",
      reason: "This occurrence's TagInfo is read-only.",
    };
  }
  if (occurrence.write_target === null) {
    return {
      kind: "read-only",
      reason:
        "This occurrence has no runtime write target and cannot be edited safely.",
    };
  }

  return {
    kind: "targetable",
    target: {
      kind: "ExistingOccurrence",
      occurrence_id: structuredClone(occurrence.id),
      schema_id: structuredClone(occurrence.schema_id),
      write_target: structuredClone(occurrence.write_target),
    },
  };
}

/** Current-value lookup for the v5 redundant-draft guard. */
export function currentValueForMetadataDraftTarget(
  occurrences: ImageMetadataOccurrencesState,
  target: MetadataDraftTarget,
): MetadataOccurrence["value"] | undefined {
  if (target.kind === "NewProperty" || occurrences === "loading") {
    return undefined;
  }
  const exact = resolveExactMetadataOccurrence(
    occurrences,
    target.occurrence_id,
  );
  if (exact.kind !== "unique") return undefined;
  const currentTarget = existingOccurrenceTargetFromOccurrence(
    exact.occurrence,
  );
  if (
    currentTarget.kind !== "targetable" ||
    !metadataDraftTargetEquals(currentTarget.target, target)
  ) {
    return undefined;
  }
  return exact.occurrence.value;
}

/** Creates a schema-driven target without inventing a runtime occurrence. */
export function newPropertyDraftTarget(
  info: TagInfo,
): NewPropertyDraftTargetResolution {
  if (!info.writable) {
    return { kind: "unavailable", reason: "read_only_schema" };
  }

  return {
    kind: "available",
    target: {
      kind: "NewProperty",
      schema_id: { ...info.id },
    },
  };
}

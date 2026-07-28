import type {
  FileMetadataOccurrencesState,
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import {
  compareMetadataOccurrenceIds,
  metadataOccurrenceIdEquals,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
import {
  compareSchemaDefinitionIds,
  schemaDefinitionIdEquals,
} from "./schemaDefinitionId";
import { resolveExactMetadataOccurrence } from "./metadataOccurrences";
import { tagInfoSupportsMetadataWrite } from "./metadataWriteSupport";
import {
  family7GroupFromSchemaId,
  metadataWriteTargetEquals,
  metadataWriteTargetToken,
} from "./metadataWriteTarget";

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
        | "unsupported_schema_kind"
        | "missing_write_target"
        | "invalid_selector_relationship";
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
      reason: "read_only_schema" | "unsupported_schema_kind";
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
    return JSON.stringify([
      "NewProperty",
      schema,
      JSON.parse(metadataWriteTargetToken(target.write_target)),
    ]);
  }

  return JSON.stringify([
    "ExistingOccurrence",
    JSON.parse(metadataOccurrenceIdToken(target.occurrence_id)),
    schema,
    JSON.parse(metadataWriteTargetToken(target.write_target)),
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
      JSON.parse(metadataWriteTargetToken(target.write_target)),
    ]);
  }

  return JSON.stringify([
    "ExistingOccurrence",
    JSON.parse(metadataOccurrenceIdToken(target.occurrence_id)),
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
  const schemaComparison = compareSchemaDefinitionIds(
    left.schema_id,
    right.schema_id,
  );
  if (schemaComparison !== 0) return schemaComparison;
  return metadataWriteTargetToken(left.write_target).localeCompare(
    metadataWriteTargetToken(right.write_target),
  );
}

export function metadataDraftTargetEquals(
  left: MetadataDraftTarget,
  right: MetadataDraftTarget,
): boolean {
  if (left.kind !== right.kind) return false;
  if (!schemaDefinitionIdEquals(left.schema_id, right.schema_id)) return false;

  if (left.kind === "NewProperty") {
    return (
      right.kind === "NewProperty" &&
      metadataWriteTargetEquals(left.write_target, right.write_target)
    );
  }
  if (right.kind === "NewProperty") return false;

  return (
    metadataOccurrenceIdEquals(left.occurrence_id, right.occurrence_id) &&
    metadataWriteTargetEquals(left.write_target, right.write_target)
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
  if (!tagInfoSupportsMetadataWrite(info)) {
    return { kind: "unavailable", reason: "unsupported_schema_kind" };
  }
  if (occurrence.write_target == null) {
    return { kind: "unavailable", reason: "missing_write_target" };
  }
  if (
    occurrence.observed_selector === null ||
    !metadataWriteTargetEquals(
      occurrence.observed_selector,
      occurrence.write_target,
    )
  ) {
    return {
      kind: "unavailable",
      reason: "invalid_selector_relationship",
    };
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
  if (!tagInfoSupportsMetadataWrite(occurrence.tag_info)) {
    return {
      kind: "read-only",
      reason:
        "This occurrence's schema kind is unsupported for metadata writes.",
    };
  }
  if (
    occurrence.observed_selector === null ||
    occurrence.write_target === null ||
    !metadataWriteTargetEquals(
      occurrence.observed_selector,
      occurrence.write_target,
    )
  ) {
    return {
      kind: "read-only",
      reason:
        "This occurrence's runtime write target is not backed by the identical observed selector and cannot be edited safely.",
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

/** Current-value lookup for the target-aware redundant-draft guard. */
export function currentValueForMetadataDraftTarget(
  occurrences: FileMetadataOccurrencesState,
  target: MetadataDraftTarget,
): MetadataOccurrence["value"] | undefined {
  if (target.kind === "NewProperty" || !Array.isArray(occurrences)) {
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
  if (!tagInfoSupportsMetadataWrite(info)) {
    return { kind: "unavailable", reason: "unsupported_schema_kind" };
  }

  return {
    kind: "available",
    target: {
      kind: "NewProperty",
      schema_id: { ...info.id },
      write_target: {
        group1: info.group,
        group7: family7GroupFromSchemaId(info.id),
        tag_name: info.name,
      },
    },
  };
}

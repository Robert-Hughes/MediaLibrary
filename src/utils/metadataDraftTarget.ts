import type {
  MetadataDraftTarget,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { metadataOccurrenceIdEquals } from "./metadataOccurrenceId";
import { schemaDefinitionIdEquals } from "./schemaDefinitionId";

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
      reason: "unknown_schema" | "read_only_schema" | "missing_write_target";
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
  const info = occurrence.tag_info;
  if (info == null) {
    return { kind: "unavailable", reason: "unknown_schema" };
  }
  if (!info.writable) {
    return { kind: "unavailable", reason: "read_only_schema" };
  }
  if (occurrence.write_target == null) {
    return { kind: "unavailable", reason: "missing_write_target" };
  }

  return {
    kind: "available",
    target: {
      kind: "ExistingOccurrence",
      occurrence_id: { ...occurrence.id },
      schema_id: { ...info.id },
      // Snapshot only: a future apply pipeline must reread the exact
      // occurrence and revalidate this selector before writing.
      write_target: { ...occurrence.write_target },
    },
  };
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

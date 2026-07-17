import type {
  ImageMetadata,
  MetadataDraftReconciliation,
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  MetadataEntry,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataTargetOutcome,
  MetadataValue,
  MetadataWriteTarget,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import {
  formatMetadataOccurrenceIdForDiagnostics,
  metadataOccurrenceIdToken,
} from "./metadataOccurrenceId";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";
import { hasOwnStringKey } from "./stringRecord";

const U32_MAX = 0xffff_ffff;

function hasOwnStringKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return keys.every((key) => hasOwnStringKey(record, key));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isU32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= U32_MAX
  );
}

export function isSchemaDefinitionId(
  value: unknown,
): value is SchemaDefinitionId {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["table", "tag_id"]) &&
    typeof value.table === "string" &&
    typeof value.tag_id === "string" &&
    (value.index === undefined || value.index === null || isU32(value.index))
  );
}

export function isMetadataOccurrenceId(
  value: unknown,
): value is MetadataOccurrenceId {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["document", "path", "tag_id", "copy"]) &&
    (value.document === null || typeof value.document === "string") &&
    typeof value.path === "string" &&
    typeof value.tag_id === "string" &&
    isU32(value.copy)
  );
}

export function isMetadataWriteTarget(
  value: unknown,
): value is MetadataWriteTarget {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["group1", "tag_name"]) &&
    typeof value.group1 === "string" &&
    typeof value.tag_name === "string"
  );
}

export function isTagKind(value: unknown): value is TagKind {
  if (
    !isRecord(value) ||
    !hasOwnStringKey(value, "kind") ||
    typeof value.kind !== "string"
  ) {
    return false;
  }
  switch (value.kind) {
    case "Text":
    case "LangAlt":
    case "Real":
    case "Rational":
    case "Boolean":
    case "Date":
    case "Time":
    case "DateTime":
    case "TimeOffset":
    case "Binary":
    case "Unknown":
      return true;
    case "Integer":
      return (
        isRecord(value.data) &&
        hasOwnStringKeys(value.data, ["min", "max"]) &&
        (value.data.min === null ||
          (typeof value.data.min === "number" &&
            Number.isInteger(value.data.min))) &&
        (value.data.max === null ||
          (typeof value.data.max === "number" &&
            Number.isInteger(value.data.max)))
      );
    case "Enum":
      return (
        isRecord(value.data) &&
        hasOwnStringKeys(value.data, ["repr", "options"]) &&
        (value.data.repr === "Integer" || value.data.repr === "String") &&
        Array.isArray(value.data.options) &&
        value.data.options.every(
          (option) =>
            isRecord(option) &&
            hasOwnStringKeys(option, ["code", "label"]) &&
            typeof option.code === "string" &&
            typeof option.label === "string",
        )
      );
    case "Bag":
    case "Seq":
    case "Alt":
      return isTagKind(value.data);
    case "Struct":
      return isRecord(value.data) && Object.values(value.data).every(isTagKind);
    default:
      return false;
  }
}

export function isTagInfo(value: unknown): value is TagInfo {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, [
      "id",
      "group",
      "name",
      "writable",
      "kind",
      "description",
    ]) &&
    isSchemaDefinitionId(value.id) &&
    typeof value.group === "string" &&
    typeof value.name === "string" &&
    typeof value.writable === "boolean" &&
    isTagKind(value.kind) &&
    (value.description === null || typeof value.description === "string") &&
    (value.storage_count === undefined ||
      typeof value.storage_count === "string")
  );
}

export function isMetadataValue(value: unknown): value is MetadataValue {
  if (
    !isRecord(value) ||
    !hasOwnStringKey(value, "kind") ||
    typeof value.kind !== "string"
  ) {
    return false;
  }

  const hasContent = hasOwnStringKey(value, "value");
  if (value.kind === "Null" || value.kind === "Binary") {
    return !hasContent;
  }
  if (!hasContent) return false;

  switch (value.kind) {
    case "Text":
      return typeof value.value === "string";
    case "Bool":
      return typeof value.value === "boolean";
    case "Integer":
      return (
        typeof value.value === "number" &&
        Number.isFinite(value.value) &&
        Number.isInteger(value.value)
      );
    case "Real":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "Rational":
      return (
        isRecord(value.value) &&
        hasOwnStringKeys(value.value, ["numerator", "denominator"]) &&
        typeof value.value.numerator === "number" &&
        Number.isInteger(value.value.numerator) &&
        typeof value.value.denominator === "number" &&
        Number.isInteger(value.value.denominator) &&
        value.value.denominator !== 0
      );
    case "Date":
      return isDateValue(value.value);
    case "Time":
      return isTimeValue(value.value);
    case "DateTime":
      return (
        isRecord(value.value) &&
        hasOwnStringKeys(value.value, ["date", "time"]) &&
        isDateValue(value.value.date) &&
        isTimeValue(value.value.time)
      );
    case "TimeOffset":
      return isUtcOffsetValue(value.value);
    case "LangAlt":
      return (
        isRecord(value.value) &&
        Object.values(value.value).every((item) => typeof item === "string")
      );
    case "List":
      return (
        isRecord(value.value) &&
        hasOwnStringKeys(value.value, ["list_kind", "items"]) &&
        isListKind(value.value.list_kind) &&
        Array.isArray(value.value.items) &&
        value.value.items.every(isMetadataValue)
      );
    case "Struct":
      return (
        isRecord(value.value) &&
        Object.values(value.value).every(isMetadataValue)
      );
    case "Unknown":
      return (
        isRecord(value.value) &&
        hasOwnStringKey(value.value, "raw") &&
        hasOwnStringKey(value.value, "expected") &&
        hasOwnStringKey(value.value, "reason") &&
        isJsonValue(value.value.raw) &&
        (value.value.expected === null || isTagKind(value.value.expected)) &&
        (value.value.reason === null || typeof value.value.reason === "string")
      );
    default:
      return false;
  }
}

export function isJsonValue(value: unknown): boolean {
  return isJsonValueInternal(value, new WeakSet<object>());
}

function isJsonValueInternal(
  value: unknown,
  ancestors: WeakSet<object>,
): boolean {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  const valid = Object.values(value).every((item) =>
    isJsonValueInternal(item, ancestors),
  );
  ancestors.delete(value);
  return valid;
}

export function isMetadataDraftTarget(
  value: unknown,
): value is MetadataDraftTarget {
  if (!isRecord(value) || !hasOwnStringKey(value, "kind")) return false;
  if (value.kind === "ExistingOccurrence") {
    return (
      hasOwnStringKeys(value, ["occurrence_id", "schema_id", "write_target"]) &&
      isMetadataOccurrenceId(value.occurrence_id) &&
      isSchemaDefinitionId(value.schema_id) &&
      isMetadataWriteTarget(value.write_target)
    );
  }
  if (value.kind === "NewProperty") {
    return (
      hasOwnStringKey(value, "schema_id") &&
      isSchemaDefinitionId(value.schema_id)
    );
  }
  return false;
}

export function isMetadataDraftEdit(
  value: unknown,
): value is MetadataDraftEdit {
  return (
    isRecord(value) &&
    hasOwnStringKey(value, "intent") &&
    (value.intent === "Set" ||
      value.intent === "Delete" ||
      value.intent === "ListAdd" ||
      value.intent === "ListRemove") &&
    hasOwnStringKey(value, "value") &&
    (value.value === null || isMetadataValue(value.value)) &&
    (value.display === undefined || typeof value.display === "string")
  );
}

export function isMetadataDraftEntryV5(
  value: unknown,
): value is MetadataDraftEntryV5 {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["target", "edit"]) &&
    isMetadataDraftTarget(value.target) &&
    isMetadataDraftEdit(value.edit)
  );
}

export function metadataOccurrenceSchemaIdentityError(
  value: unknown,
): string | null {
  if (
    !isRecord(value) ||
    !isMetadataOccurrenceId(value.id) ||
    !isSchemaDefinitionId(value.schema_id) ||
    value.tag_info === null ||
    !isTagInfo(value.tag_info) ||
    schemaDefinitionIdEquals(value.tag_info.id, value.schema_id)
  ) {
    return null;
  }

  return [
    "Metadata occurrence schema mismatch:",
    `occurrence ID ${formatMetadataOccurrenceIdForDiagnostics(value.id)}`,
    `occurrence schema ${formatSchemaDefinitionIdForDiagnostics(value.schema_id)}`,
    `TagInfo schema ${formatSchemaDefinitionIdForDiagnostics(value.tag_info.id)}`,
  ].join(" ");
}

export function isMetadataOccurrence(
  value: unknown,
): value is MetadataOccurrence {
  return (
    isRecord(value) &&
    hasExactlyOwnStringKeys(value, [
      "id",
      "schema_id",
      "value",
      "tag_info",
      "write_target",
    ]) &&
    isMetadataOccurrenceId(value.id) &&
    isSchemaDefinitionId(value.schema_id) &&
    isMetadataValue(value.value) &&
    (value.tag_info === null || isTagInfo(value.tag_info)) &&
    (value.tag_info === null ||
      schemaDefinitionIdEquals(value.tag_info.id, value.schema_id)) &&
    (value.write_target === null || isMetadataWriteTarget(value.write_target))
  );
}

export function isMetadataEntry(value: unknown): value is MetadataEntry {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["id", "value"]) &&
    isSchemaDefinitionId(value.id) &&
    isMetadataValue(value.value)
  );
}

export type ImageMetadataDuplicateIdentity = {
  kind: "occurrence" | "schema";
  token: string;
  firstIndex: number;
  secondIndex: number;
};

function findDuplicateIdentity<T>(
  values: T[],
  kind: ImageMetadataDuplicateIdentity["kind"],
  tokenFor: (value: T) => string,
): ImageMetadataDuplicateIdentity | null {
  const firstIndexes = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const token = tokenFor(value);
    const firstIndex = firstIndexes.get(token);
    if (firstIndex !== undefined) {
      return { kind, token, firstIndex, secondIndex: index };
    }
    firstIndexes.set(token, index);
  }
  return null;
}

export function findImageMetadataDuplicateIdentity(
  value: unknown,
): ImageMetadataDuplicateIdentity | null {
  if (!isRecord(value)) return null;

  if (
    Array.isArray(value.occurrences) &&
    value.occurrences.every(isMetadataOccurrence)
  ) {
    const duplicate = findDuplicateIdentity(
      value.occurrences,
      "occurrence",
      (occurrence) => metadataOccurrenceIdToken(occurrence.id),
    );
    if (duplicate) return duplicate;
  }

  if (Array.isArray(value.metadata) && value.metadata.every(isMetadataEntry)) {
    return findDuplicateIdentity(value.metadata, "schema", (entry) =>
      schemaDefinitionIdToken(entry.id),
    );
  }

  return null;
}

export function isImageMetadata(value: unknown): value is ImageMetadata {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["relative_path", "occurrences", "metadata"]) &&
    typeof value.relative_path === "string" &&
    Array.isArray(value.occurrences) &&
    value.occurrences.every(isMetadataOccurrence) &&
    Array.isArray(value.metadata) &&
    value.metadata.every(isMetadataEntry) &&
    findImageMetadataDuplicateIdentity(value) === null
  );
}

function hasExactlyOwnStringKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(record);
  return (
    actual.length === expected.length &&
    expected.every((key) => hasOwnStringKey(record, key))
  );
}

export function isMetadataDraftReconciliation(
  value: unknown,
): value is MetadataDraftReconciliation {
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "Clear":
    case "Keep":
      return hasExactlyOwnStringKeys(value, ["kind"]);
    case "Replace":
      return (
        hasExactlyOwnStringKeys(value, ["kind", "target"]) &&
        isMetadataDraftTarget(value.target)
      );
    case "Blocked":
      return (
        hasExactlyOwnStringKeys(value, ["kind", "reason"]) &&
        typeof value.reason === "string"
      );
    default:
      return false;
  }
}

export function isMetadataTargetOutcome(
  value: unknown,
): value is MetadataTargetOutcome {
  if (
    !isRecord(value) ||
    !hasOwnStringKeys(value, [
      "target",
      "draft_reconciliation",
      "display_name",
      "kind",
      "sent",
      "before",
      "observed",
      "message",
    ]) ||
    !isMetadataDraftTarget(value.target) ||
    !isMetadataDraftReconciliation(value.draft_reconciliation) ||
    typeof value.display_name !== "string" ||
    typeof value.kind !== "string" ||
    !(value.sent === null || isMetadataValue(value.sent)) ||
    !(value.before === null || isMetadataValue(value.before)) ||
    !(value.observed === null || isMetadataValue(value.observed)) ||
    !(value.message === null || typeof value.message === "string")
  ) {
    return false;
  }

  const reconciliation = value.draft_reconciliation;
  if (reconciliation.kind !== "Replace") return true;

  return (
    value.target.kind === "NewProperty" &&
    reconciliation.target.kind === "ExistingOccurrence" &&
    schemaDefinitionIdEquals(
      value.target.schema_id,
      reconciliation.target.schema_id,
    )
  );
}

function isDateValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["year", "month", "day"]) &&
    typeof value.year === "number" &&
    Number.isInteger(value.year) &&
    typeof value.month === "number" &&
    Number.isInteger(value.month) &&
    value.month >= 1 &&
    value.month <= 12 &&
    typeof value.day === "number" &&
    Number.isInteger(value.day) &&
    value.day >= 1 &&
    value.day <= 31
  );
}

function isTimeValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, [
      "hour",
      "minute",
      "second",
      "subsecond",
      "offset",
    ]) &&
    typeof value.hour === "number" &&
    Number.isInteger(value.hour) &&
    value.hour >= 0 &&
    value.hour <= 23 &&
    typeof value.minute === "number" &&
    Number.isInteger(value.minute) &&
    value.minute >= 0 &&
    value.minute <= 59 &&
    typeof value.second === "number" &&
    Number.isInteger(value.second) &&
    value.second >= 0 &&
    value.second <= 59 &&
    (value.subsecond === null || typeof value.subsecond === "string") &&
    (value.offset === null || isUtcOffsetValue(value.offset))
  );
}

function isUtcOffsetValue(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOwnStringKeys(value, ["sign", "hours", "minutes"]) &&
    (value.sign === "Plus" || value.sign === "Minus") &&
    typeof value.hours === "number" &&
    Number.isInteger(value.hours) &&
    value.hours >= 0 &&
    value.hours <= 23 &&
    typeof value.minutes === "number" &&
    Number.isInteger(value.minutes) &&
    value.minutes >= 0 &&
    value.minutes <= 59
  );
}

function isListKind(value: unknown): boolean {
  return (
    value === "Bag" || value === "Seq" || value === "Alt" || value === "Unknown"
  );
}

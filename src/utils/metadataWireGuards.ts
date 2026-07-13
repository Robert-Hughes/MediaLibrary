import type {
  MetadataDraftEdit,
  MetadataDraftEntryV5,
  MetadataDraftTarget,
  MetadataOccurrenceId,
  MetadataValue,
  MetadataWriteTarget,
  SchemaDefinitionId,
  TagKind,
} from "../types";
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

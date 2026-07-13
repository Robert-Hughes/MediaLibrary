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

const U32_MAX = 0xffff_ffff;

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
    typeof value.group1 === "string" &&
    typeof value.tag_name === "string"
  );
}

export function isTagKind(value: unknown): value is TagKind {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
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
        (value.data.repr === "Integer" || value.data.repr === "String") &&
        Array.isArray(value.data.options) &&
        value.data.options.every(
          (option) =>
            isRecord(option) &&
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
  if (!isRecord(value) || typeof value.kind !== "string") return false;

  switch (value.kind) {
    case "Null":
    case "Binary":
      return true;
    case "Text":
      return typeof value.value === "string";
    case "Bool":
      return typeof value.value === "boolean";
    case "Integer":
    case "Real":
      return typeof value.value === "number" && Number.isFinite(value.value);
    case "Rational":
      return (
        isRecord(value.value) &&
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
        "raw" in value.value &&
        (value.value.expected === null || isTagKind(value.value.expected)) &&
        (value.value.reason === null || typeof value.value.reason === "string")
      );
    default:
      return false;
  }
}

export function isMetadataDraftTarget(
  value: unknown,
): value is MetadataDraftTarget {
  if (!isRecord(value)) return false;
  if (value.kind === "ExistingOccurrence") {
    return (
      isMetadataOccurrenceId(value.occurrence_id) &&
      isSchemaDefinitionId(value.schema_id) &&
      isMetadataWriteTarget(value.write_target)
    );
  }
  if (value.kind === "NewProperty") {
    return isSchemaDefinitionId(value.schema_id);
  }
  return false;
}

export function isMetadataDraftEdit(
  value: unknown,
): value is MetadataDraftEdit {
  return (
    isRecord(value) &&
    (value.intent === "Set" ||
      value.intent === "Delete" ||
      value.intent === "ListAdd" ||
      value.intent === "ListRemove") &&
    "value" in value &&
    (value.value === null || isMetadataValue(value.value)) &&
    (value.display === undefined || typeof value.display === "string")
  );
}

export function isMetadataDraftEntryV5(
  value: unknown,
): value is MetadataDraftEntryV5 {
  return (
    isRecord(value) &&
    isMetadataDraftTarget(value.target) &&
    isMetadataDraftEdit(value.edit)
  );
}

function isDateValue(value: unknown): boolean {
  return (
    isRecord(value) &&
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

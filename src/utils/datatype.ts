import type { ImageMetadataEntry, MetadataValue, TagKind } from "../types";

export interface DatatypeInfo {
  code: string;
  label: string;
}

/**
 * Map a schema {@link TagKind} to a short datatype badge.  Returns `null`
 * when the schema is unknown (caller renders no badge).
 */
export function schemaDatatype(
  kind: TagKind | null | undefined,
): DatatypeInfo | null {
  if (!kind) return null;
  switch (kind.kind) {
    case "Text":
      return { code: "S", label: "String" };
    case "LangAlt":
      return { code: "LA", label: "LangAlt" };
    case "Integer":
      return { code: "I", label: "Integer" };
    case "Real":
      return { code: "R", label: "Real" };
    case "Rational":
      return { code: "Q", label: "Rational" };
    case "Boolean":
      return { code: "B", label: "Boolean" };
    case "Date":
      return { code: "D", label: "Date" };
    case "Time":
      return { code: "T", label: "Time" };
    case "DateTime":
      return { code: "DT", label: "DateTime" };
    case "TimeOffset":
      return { code: "TZ", label: "Time offset" };
    case "Enum":
      return { code: "E", label: "Enum" };
    case "Bag":
      return { code: "[B]", label: "Bag (unordered list)" };
    case "Seq":
      return { code: "[S]", label: "Seq (ordered list)" };
    case "Alt":
      return { code: "[A]", label: "Alt (alternatives)" };
    case "Struct":
      return { code: "{}", label: "Struct" };
    case "Binary":
      return { code: "Bin", label: "Binary" };
    // `Unknown` means exiftool listed the tag with type `?`/`""`/`undef` —
    // present in the schema but with no committed datatype. Conveys no
    // useful information to the user, so suppress the badge entirely and
    // let the row fall back to the "no schema" rendering path.
    case "Unknown":
      return null;
  }
}

/**
 * Map a runtime {@link ImageMetadataEntry} to its datatype badge.  Returns
 * `null` when there is no value to describe (undefined input).
 *
 * The function also accepts raw JSON shapes (string / number / boolean /
 * array / object) for the fallback path where the backend has emitted a
 * value that was not wrapped in a typed {@link MetadataValue} envelope.
 */
export function metadataEntryDatatype(
  v: ImageMetadataEntry | undefined,
): DatatypeInfo | null {
  if (v === undefined) return null;
  if (isMetadataValue(v)) return metadataValueDatatype(v);
  if (v === null) return { code: "∅", label: "Null" };
  if (typeof v === "boolean") return { code: "B", label: "Boolean" };
  if (typeof v === "number") return { code: "N", label: "Number" };
  if (typeof v === "string") return { code: "S", label: "String" };
  if (Array.isArray(v)) return { code: "L", label: "List" };
  if (typeof v === "object") return { code: "{}", label: "Object" };
  return null;
}

function isMetadataValue(value: unknown): value is MetadataValue {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "kind" in value &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

export function metadataValueDatatype(
  v: MetadataValue | undefined,
): DatatypeInfo | null {
  if (v === undefined) return null;
  switch (v.kind) {
    case "Null":
      return { code: "∅", label: "Null" };
    case "Text":
      return { code: "S", label: "String" };
    case "Bool":
      return { code: "B", label: "Boolean" };
    case "Integer":
      return { code: "I", label: "Integer" };
    case "Real":
      return { code: "R", label: "Real" };
    case "Rational":
      return { code: "Q", label: "Rational" };
    case "Date":
      return { code: "D", label: "Date" };
    case "Time":
      return { code: "T", label: "Time" };
    case "DateTime":
      return { code: "DT", label: "DateTime" };
    case "TimeOffset":
      return { code: "TZ", label: "Time offset" };
    case "LangAlt":
      return { code: "LA", label: "LangAlt" };
    case "List":
      switch (v.value.list_kind) {
        case "Bag":
          return { code: "[B]", label: "Bag (unordered list)" };
        case "Seq":
          return { code: "[S]", label: "Seq (ordered list)" };
        case "Alt":
          return { code: "[A]", label: "Alt (alternatives)" };
        case "Unknown":
          return { code: "L", label: "List" };
      }
      break;
    case "Struct":
      return { code: "{}", label: "Struct" };
    case "Binary":
      return { code: "Bin", label: "Binary" };
    case "Unknown":
      return { code: "?", label: "Unparsed" };
  }
  return null;
}

/**
 * Decide whether a runtime datatype code is compatible with a schema code.
 * The fallback JSON path collapses int/real to the `N` (number) code, so
 * `N` matches both `I` and `R`.  Rational (`Q`) is wire-encoded as a
 * `"num/den"` string on the legacy path, so `N` vs `Q` is a mismatch.
 */
export function datatypesMatch(
  variantCode: string,
  schemaCode: string,
): boolean {
  if (variantCode === schemaCode) return true;
  if (variantCode === "N") return schemaCode === "I" || schemaCode === "R";
  if (variantCode === "S") {
    return (
      schemaCode === "LA" ||
      schemaCode === "D" ||
      schemaCode === "T" ||
      schemaCode === "DT" ||
      schemaCode === "TZ" ||
      schemaCode === "E" ||
      schemaCode === "Q"
    );
  }
  if (variantCode === "L") {
    return schemaCode === "[B]" || schemaCode === "[S]" || schemaCode === "[A]";
  }
  return false;
}

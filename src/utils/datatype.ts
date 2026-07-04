import type { MetadataValue, TagKind, Variant } from "../types";

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
 * Map a runtime {@link Variant} value to its datatype badge.  Returns
 * `null` when there is no value to describe (undefined input).
 */
export function variantDatatype(v: Variant | undefined): DatatypeInfo | null {
  if (v === undefined) return null;
  if (v === null) return { code: "∅", label: "Null" };
  if (typeof v === "boolean") return { code: "B", label: "Boolean" };
  if (typeof v === "number") return { code: "N", label: "Number" };
  if (typeof v === "string") return { code: "S", label: "String" };
  if (Array.isArray(v)) return { code: "L", label: "List" };
  if (typeof v === "object") return { code: "{}", label: "Object" };
  return null;
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
 * Decide whether a runtime variant code is compatible with a schema code.
 * The JS Variant collapses int/real to `number`, so `N` is treated as a
 * match for both `I` and `R`.  Rational (`Q`) is wire-encoded as a
 * `"num/den"` string, so a numeric variant against `Q` is a mismatch.
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

import type {
  DraftEdit,
  DraftEditsByFile,
  ImageMetadataEntry,
  MetadataDraftEdit,
  MetadataValue,
  Variant,
} from "../types";
import { metadataValueToDisplayString } from "../draft";
import { variantToMetadataValue } from "./scanEvents";

export type MetadataDraftEditsByFile = Record<
  string,
  Record<string, MetadataDraftEdit>
>;

export function legacyDraftsToMetadataDrafts(
  drafts: DraftEditsByFile,
): MetadataDraftEditsByFile {
  return Object.fromEntries(
    Object.entries(drafts).map(([path, edits]) => [
      path,
      Object.fromEntries(
        Object.entries(edits).map(([tag, edit]) => [
          tag,
          legacyDraftToMetadataDraft(edit),
        ]),
      ),
    ]),
  );
}

export function metadataDraftsToLegacyDrafts(
  drafts: MetadataDraftEditsByFile,
): DraftEditsByFile {
  return Object.fromEntries(
    Object.entries(drafts).map(([path, edits]) => [
      path,
      Object.fromEntries(
        Object.entries(edits).map(([tag, edit]) => [
          tag,
          metadataDraftToLegacyDraft(edit),
        ]),
      ),
    ]),
  );
}

export function legacyDraftToMetadataDraft(edit: DraftEdit): MetadataDraftEdit {
  return {
    value:
      edit.value === null || edit.value === undefined
        ? null
        : variantToMetadataValue(edit.value),
    intent: edit.intent,
    display: edit.display,
  };
}

export function metadataDraftToLegacyDraft(edit: MetadataDraftEdit): DraftEdit {
  return {
    value:
      edit.value === null || edit.value === undefined
        ? null
        : metadataValueToVariant(edit.value),
    intent: edit.intent,
    display: edit.display ?? metadataValueToDisplayString(edit.value),
  };
}

export function metadataEntryToVariant(
  value: ImageMetadataEntry | null | undefined,
): Variant | null {
  if (value === null || value === undefined) return null;
  if (!isMetadataValue(value)) return value;
  return metadataValueToVariant(value);
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

export function metadataValueToVariant(value: MetadataValue): Variant {
  switch (value.kind) {
    case "Null":
      return null;
    case "Text":
    case "Bool":
    case "Integer":
    case "Real":
      return value.value;
    case "Rational":
      return value.value.denominator === 0
        ? null
        : value.value.numerator / value.value.denominator;
    case "Date":
    case "Time":
    case "DateTime":
    case "TimeOffset":
      return metadataValueToDisplayString(value);
    case "LangAlt":
      return Object.fromEntries(
        Object.entries(value.value).map(([lang, text]) => [lang, text]),
      );
    case "List":
      return value.value.items.map(metadataValueToVariant);
    case "Struct":
      return Object.fromEntries(
        Object.entries(value.value).map(([key, child]) => [
          key,
          child ? metadataValueToVariant(child) : null,
        ]),
      );
    case "Binary":
    case "Unknown":
      return null;
  }
}

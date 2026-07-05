import type {
  DraftEdit,
  MetadataDraftEdit,
  MetadataValue,
  Variant,
} from "../types";
import { metadataValueToDisplayString } from "../draft";
import { variantToMetadataValue } from "./scanEvents";

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

import type {
  DraftEdit,
  DraftEditsByFile,
  EditIntent,
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

export function normalizeGeneratedDraftEdits(
  raw: unknown,
): Record<string, DraftEdit> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, DraftEdit> = {};
  for (const [tag, value] of Object.entries(raw as Record<string, unknown>)) {
    out[tag] = normalizeGeneratedDraftEdit(value);
  }
  return out;
}

function normalizeGeneratedDraftEdit(raw: unknown): DraftEdit {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { value: normalizeLegacyVariant(raw), intent: "Set" };
  }

  const candidate = raw as {
    value?: unknown;
    intent?: unknown;
    display?: unknown;
  };
  const intent = normalizeIntent(candidate.intent);
  const display =
    typeof candidate.display === "string" ? candidate.display : undefined;

  if (isMetadataValue(candidate.value)) {
    return metadataDraftToLegacyDraft({
      value: candidate.value,
      intent,
      display,
    });
  }

  return {
    value:
      candidate.value === null || candidate.value === undefined
        ? null
        : normalizeLegacyVariant(candidate.value),
    intent,
    display,
  };
}

function normalizeIntent(value: unknown): EditIntent {
  return value === "Delete" ||
    value === "ListAdd" ||
    value === "ListRemove" ||
    value === "Set"
    ? value
    : "Set";
}

function normalizeLegacyVariant(value: unknown): Variant | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeLegacyVariant);
  if (typeof value === "object") {
    const wrapped = value as { type?: unknown; value?: unknown };
    if (typeof wrapped.type === "string" && "value" in wrapped) {
      switch (wrapped.type) {
        case "String":
          return typeof wrapped.value === "string"
            ? wrapped.value
            : String(wrapped.value ?? "");
        case "Integer":
        case "Float":
        case "Number":
          return typeof wrapped.value === "number"
            ? wrapped.value
            : Number(wrapped.value);
        case "Bool":
        case "Boolean":
          return Boolean(wrapped.value);
        case "List":
          return Array.isArray(wrapped.value)
            ? wrapped.value.map(normalizeLegacyVariant)
            : [];
        case "Object":
          return normalizeLegacyVariant(wrapped.value);
        case "Null":
          return null;
      }
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeLegacyVariant(child),
      ]),
    );
  }
  return null;
}

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

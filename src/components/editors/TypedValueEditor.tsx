// Schema-aware editor router (Phase 4 MVP).
//
// Picks an editor component based on the tag's TagKind:
//
// - Bag<Text>   → BagEditor (chip list; first concrete typed editor)
// - Seq<Text>   → BagEditor (with order preserved by typed-list save)
// - everything  → legacy ValueEditDialog (single text input)
//
// As more typed editors land (LangAlt, Enum, Integer, GPS, Flash, Struct),
// they get added as cases here.  The fallback to ValueEditDialog keeps the
// existing UI working for every tag we haven't migrated yet.

import { useTagInfo } from "../../hooks/useTagInfo";
import type { DraftEdit, TagKind, Variant } from "../../types";
import { ValueEditDialog } from "../ValueEditDialog";
import { BagEditor, initialItemsFrom } from "./BagEditor";
import { EnumEditor, initialCodeFrom } from "./EnumEditor";
import { LangAltEditor, initialLangsFrom } from "./LangAltEditor";
import { NumericEditor } from "./NumericEditor";
import { BooleanEditor } from "./BooleanEditor";
import { DateTimeEditor } from "./DateTimeEditor";
import { GpsEditor, gpsGroupFor, parseDecimalDegrees, parseHemisphere } from "./GpsEditor";
import { FlashEditor, isFlashTag } from "./FlashEditor";
import { variantToDisplayString } from "../../draft";

interface Props {
  propertyKey: string;
  /** Current value as a Variant (from raw_metadata or display) or fall back to the legacy string. */
  initialVariant?: Variant;
  initialString: string;
  /** Full metadata for the file (used by LangAltEditor and GpsEditor to gather sibling keys). */
  metadataForFile?: Record<string, Variant>;
  onSave: (edit: DraftEdit) => void;
  /** Multi-tag save, used by GpsEditor and any future paired-tag editor. */
  onSaveBatch?: (edits: Array<{ key: string; edit: DraftEdit }>) => void;
  onCancel: () => void;
}

function isBagOrSeqOfText(kind: TagKind): boolean {
  if (kind.kind !== "Bag" && kind.kind !== "Seq") return false;
  const inner = kind.data;
  return inner.kind === "Text" || inner.kind === "Unknown";
}

export function TypedValueEditor({
  propertyKey,
  initialVariant,
  initialString,
  metadataForFile,
  onSave,
  onSaveBatch,
  onCancel,
}: Props) {
  const tag = useTagInfo(propertyKey);

  // Flash override (name-matched, takes precedence over the schema's
  // generic Enum<Integer> view because the bitfield decoder makes the
  // user experience far better than a flat dropdown of 0–127 codes).
  if (isFlashTag(propertyKey)) {
    const code =
      typeof initialVariant === "number"
        ? Math.trunc(initialVariant)
        : Number(initialString) || 0;
    return (
      <FlashEditor
        propertyKey={propertyKey}
        initialCode={code}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // GPS override (name-matched, not schema-kind-matched): writable only when
  // we have a multi-tag save callback because the editor writes 4 paired tags.
  const gpsGroup = onSaveBatch ? gpsGroupFor(propertyKey) : null;
  if (gpsGroup && metadataForFile) {
    const latVal = metadataForFile[gpsGroup.latitudeKey];
    const lonVal = metadataForFile[gpsGroup.longitudeKey];
    return (
      <GpsEditor
        group={gpsGroup}
        initialLatDecimal={parseDecimalDegrees(latVal)}
        initialLatRef={parseHemisphere(metadataForFile[gpsGroup.latitudeRefKey] ?? latVal, "lat") as "N" | "S"}
        initialLonDecimal={parseDecimalDegrees(lonVal)}
        initialLonRef={parseHemisphere(metadataForFile[gpsGroup.longitudeRefKey] ?? lonVal, "lon") as "E" | "W"}
        onSave={onSaveBatch!}
        onCancel={onCancel}
      />
    );
  }

  if (tag === "loading") {
    // First-call lookup; schema build can take 100-500ms.  Show the legacy
    // text editor so the user isn't blocked.  Switching to a richer editor
    // mid-typing would lose input, so this is a one-render decision.
    return (
      <ValueEditDialog
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={(s) => onSave({ value: s, intent: "Set" })}
        onCancel={onCancel}
      />
    );
  }

  if (tag && isBagOrSeqOfText(tag.kind)) {
    const initialItems = initialItemsFrom(initialVariant ?? initialString);
    return (
      <BagEditor
        propertyKey={propertyKey}
        initialItems={initialItems}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (tag && tag.kind.kind === "Enum") {
    const { repr, options } = tag.kind.data;
    const code = initialCodeFrom(initialVariant, undefined, options);
    return (
      <EnumEditor
        propertyKey={propertyKey}
        repr={repr}
        options={options}
        initialCode={code === "" ? initialString : code}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (tag && (tag.kind.kind === "Integer" || tag.kind.kind === "Real" || tag.kind.kind === "Rational")) {
    const min = tag.kind.kind === "Integer" ? tag.kind.data.min : null;
    const max = tag.kind.kind === "Integer" ? tag.kind.data.max : null;
    return (
      <NumericEditor
        propertyKey={propertyKey}
        kind={tag.kind.kind}
        min={min}
        max={max}
        initialValue={initialString}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (tag && tag.kind.kind === "Boolean") {
    const v = typeof initialVariant === "boolean"
      ? initialVariant
      : initialString.toLowerCase() === "true" || initialString === "1"
      ? true
      : initialString.toLowerCase() === "false" || initialString === "0"
      ? false
      : null;
    return (
      <BooleanEditor
        propertyKey={propertyKey}
        initialValue={v}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (tag && tag.kind.kind === "DateTime") {
    return (
      <DateTimeEditor
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (tag && tag.kind.kind === "LangAlt") {
    const initialLangs = initialLangsFrom(initialVariant, metadataForFile ?? {}, propertyKey);
    if (Object.keys(initialLangs).length === 0 && initialString) {
      initialLangs["x-default"] = initialString;
    }
    return (
      <LangAltEditor
        propertyKey={propertyKey}
        initialLangs={initialLangs}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // Fallback: legacy text input.
  return (
    <ValueEditDialog
      propertyKey={propertyKey}
      initialValue={initialString}
      onSave={(s) => onSave({ value: s, intent: "Set" })}
      onCancel={onCancel}
    />
  );
}

/** Pretty-print a Variant for the "initialString" prop fallback. */
export const fallbackString = variantToDisplayString;

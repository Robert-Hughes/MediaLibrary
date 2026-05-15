// Schema-aware editor router.
//
// Picks an editor component based on the tag's TagKind plus a small set of
// name- and pattern-based overrides centralised in
// `src/metadata/tag_overrides.ts`.  See METADATA_FORMATS_DESIGN.md §5 for
// the full table.
//
// Lookup precedence (Phase 8):
//
//   1. Override matchers (Flash, GPS, date-name pattern).  These win even
//      against the schema kind because the override editor is materially
//      better than what the schema would produce.
//   2. Schema TagKind.  Drives the regular editor table.
//   3. Variant-shape fallbacks for tags exiftool returns as Object/struct
//      with no schema entry.
//   4. Plain text input as a last resort.
//
// Two TagKinds exist purely to satisfy design §5:
//   - Unknown — render a text input plus a warning the user is editing a
//                tag the schema doesn't describe.
//   - Binary  — read-only "binary, not editable in app" message.

import { useState } from "react";
import { useTagInfo } from "../../hooks/useTagInfo";
import type { DraftEdit, TagKind, Variant } from "../../types";
import { ValueEditDialog } from "../ValueEditDialog";
import { BagEditor, initialItemsFrom, type BagInnerKind } from "./BagEditor";
import { EnumEditor, initialCodeFrom } from "./EnumEditor";
import { LangAltEditor, initialLangsFrom } from "./LangAltEditor";
import { NumericEditor } from "./NumericEditor";
import { RationalEditor } from "./RationalEditor";
import { BooleanEditor } from "./BooleanEditor";
import { DateTimeEditor } from "./DateTimeEditor";
import { GpsEditor, parseDecimalDegrees, parseHemisphere } from "./GpsEditor";
import { FlashEditor } from "./FlashEditor";
import { StructEditor, initialObjectFrom } from "./StructEditor";
import { variantToDisplayString } from "../../draft";
import {
  gpsTagGroup,
  isFlashTag,
  isDateTimeNamePattern,
} from "../../metadata/tag_overrides";

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

/** Returns the inner BagInnerKind if `kind` is a Bag or Seq whose inner
 *  is one of the scalar kinds the chip editor can round-trip; null otherwise.
 *  Bag<Struct> / Bag<LangAlt> / Bag<Bag<…>> fall through to the default
 *  router because the chip editor can't represent those without a proper
 *  per-item nested editor (deferred). */
function bagInnerScalar(kind: TagKind): BagInnerKind | null {
  if (kind.kind !== "Bag" && kind.kind !== "Seq") return null;
  const inner = kind.data;
  switch (inner.kind) {
    case "Text":
    case "Unknown":
      return inner.kind;
    case "Integer":
      return "Integer";
    case "Real":
      return "Real";
    case "Boolean":
      return "Boolean";
    default:
      return null;
  }
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

  // ── Override 1: Flash bitfield ─────────────────────────────────────────
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

  // ── Override 2: GPS composite editor (writable only with paired-batch save). ─
  const gpsGroup = onSaveBatch ? gpsTagGroup(propertyKey) : null;
  if (gpsGroup && metadataForFile) {
    const latVal = metadataForFile[gpsGroup.latitudeKey];
    const lonVal = metadataForFile[gpsGroup.longitudeKey];
    const altVal = metadataForFile[gpsGroup.altitudeKey];
    const altRefVal = metadataForFile[gpsGroup.altitudeRefKey];
    // exiftool's GPSAltitudeRef is `0` (above) or `1` (below) in raw form;
    // pretty form may render as "Above Sea Level" / "Below Sea Level".
    let initialAltitudeRef: "above" | "below" = "above";
    if (typeof altRefVal === "number") {
      initialAltitudeRef = altRefVal === 1 ? "below" : "above";
    } else if (typeof altRefVal === "string" && /below/i.test(altRefVal)) {
      initialAltitudeRef = "below";
    }
    const initialAltitudeMetres =
      typeof altVal === "number" ? altVal
      : typeof altVal === "string" && altVal.trim() !== "" ? parseFloat(altVal)
      : null;
    return (
      <GpsEditor
        group={gpsGroup}
        initialLatDecimal={parseDecimalDegrees(latVal)}
        initialLatRef={parseHemisphere(metadataForFile[gpsGroup.latitudeRefKey] ?? latVal, "lat") as "N" | "S"}
        initialLonDecimal={parseDecimalDegrees(lonVal)}
        initialLonRef={parseHemisphere(metadataForFile[gpsGroup.longitudeRefKey] ?? lonVal, "lon") as "E" | "W"}
        initialAltitudeMetres={Number.isFinite(initialAltitudeMetres as number) ? (initialAltitudeMetres as number) : null}
        initialAltitudeRef={initialAltitudeRef}
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

  if (tag) {
    const inner = bagInnerScalar(tag.kind);
    if (inner) {
      const initialItems = initialItemsFrom(initialVariant ?? initialString);
      return (
        <BagEditor
          propertyKey={propertyKey}
          initialItems={initialItems}
          ordered={tag.kind.kind === "Seq"}
          innerKind={inner}
          onSave={onSave}
          onCancel={onCancel}
        />
      );
    }
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

  // Phase 8.4: Rational gets a dedicated num/den editor.  Integer / Real
  // continue to use the single-input NumericEditor.
  if (tag && tag.kind.kind === "Rational") {
    return (
      <RationalEditor
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  if (tag && (tag.kind.kind === "Integer" || tag.kind.kind === "Real")) {
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

  if (tag && tag.kind.kind === "Struct") {
    const initialObject = initialObjectFrom(initialVariant);
    return (
      <StructEditor
        propertyKey={propertyKey}
        initialObject={initialObject}
        innerEditor={TypedValueEditor}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // ── Phase 8.3: Binary — read-only with explanation. ───────────────────
  if (tag && tag.kind.kind === "Binary") {
    return (
      <div className="dialog-overlay" data-testid="binary-editor-overlay">
        <div className="dialog-content">
          <h3>{propertyKey}</h3>
          <div className="dialog-body">
            <p className="dialog-hint" data-testid="binary-editor-message">
              This tag holds binary data and is not editable in this app.  Use
              ExifTool directly if you need to write it.
            </p>
          </div>
          <div className="dialog-footer">
            <button className="dialog-btn dialog-btn-primary" onClick={onCancel}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Also route Variant::Object values that come through tags whose schema
  // claims Text — common for tags listx doesn't describe as struct but
  // exiftool's -struct flag has nonetheless delivered as an object.  LangAlt
  // is handled above so we won't intercept Description-style objects here.
  if (initialVariant && typeof initialVariant === "object" && !Array.isArray(initialVariant)) {
    return (
      <StructEditor
        propertyKey={propertyKey}
        initialObject={initialObjectFrom(initialVariant)}
        innerEditor={TypedValueEditor}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // ── Phase 8.5: date-name pattern upgrade. ─────────────────────────────
  // Tag is Text per schema, but its name and value both look like a date —
  // give the user a real date picker instead of a free-form text box.
  //
  // Use `initialString` (display view) rather than `initialVariant` (raw).
  // raw_metadata for date tags is often a number (e.g. exiftool's -n form
  // for some camera fields) which would never match the YYYY:MM:DD…
  // pattern; the display view is the canonical exiftool date string.
  if (
    (!tag || tag.kind.kind === "Text" || tag.kind.kind === "Unknown")
    && isDateTimeNamePattern(propertyKey, initialString)
  ) {
    return (
      <DateTimeEditor
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  // ── Phase 8.3: Unknown — text input plus a warning. ───────────────────
  if (tag && tag.kind.kind === "Unknown") {
    return (
      <UnknownEditor
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={(s) => onSave({ value: s, intent: "Set" })}
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

// Local Unknown-tag editor: same shape as ValueEditDialog but with a banner
// warning the user the schema doesn't describe this tag.  Phase 8.3.
function UnknownEditor({
  propertyKey,
  initialValue,
  onSave,
  onCancel,
}: {
  propertyKey: string;
  initialValue: string;
  onSave: (s: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onSave(value);
    else if (e.key === "Escape") onCancel();
  };
  return (
    <div className="dialog-overlay" data-testid="unknown-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        <div className="dialog-body">
          <p
            className="dialog-hint"
            data-testid="unknown-editor-warning"
            style={{ color: "var(--accent-warning, #aa6)", marginBottom: 8 }}
          >
            ⚠ This tag is not in ExifTool's writable schema.  Treating it as
            raw text — your edit may be silently rejected by ExifTool.
          </p>
          <input
            type="text"
            className="dialog-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKey}
            autoFocus
            data-testid="unknown-editor-input"
          />
        </div>
        <div className="dialog-footer">
          <button className="dialog-btn dialog-btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog-btn dialog-btn-primary" onClick={() => onSave(value)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// Schema-aware editor router.
//
// Picks an editor component based on the tag's TagKind plus a small set of
// explicit editor overrides centralised in
// `src/metadata/tag_overrides.ts`.  See METADATA_FORMATS_DESIGN.md §5 for
// the full table.
//
// Lookup precedence (Phase 8):
//
//   1. Override matchers (Flash, GPS).  These win even
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
import type {
  DraftEdit,
  MetadataDraftEdit,
  TagInfo,
  TagKind,
  Variant,
} from "../../types";
import { ValueEditDialog } from "../ValueEditDialog";
import { BagEditor, type BagInnerKind } from "./BagEditor";
import { EnumEditor } from "./EnumEditor";
import { LangAltEditor } from "./LangAltEditor";
import { NumericEditor } from "./NumericEditor";
import { RationalEditor } from "./RationalEditor";
import { BooleanEditor } from "./BooleanEditor";
import { DateTimeEditor } from "./DateTimeEditor";
import { GpsEditor } from "./GpsEditor";
import { FlashEditor } from "./FlashEditor";
import { StructEditor } from "./StructEditor";
import { READ_ONLY_TOOLTIP } from "./readOnlyMessages";
import { NestedListEditor } from "./NestedListEditor";
import {
  initialItemsFrom,
  initialCodeFrom,
  initialLangsFrom,
  parseDecimalDegrees,
  parseHemisphere,
  initialObjectFrom,
  initialItemsFromVariant,
} from "./editorHelpers";

import { gpsTagGroup, isFlashTag } from "../../metadata/tag_overrides";
import { EditorMetaHint, type EditorMetaSource } from "./EditorMetaHint";
import {
  legacyDraftToMetadataDraft,
  metadataDraftToLegacyDraft,
} from "../../utils/semanticDrafts";

interface Props {
  propertyKey: string;
  /** Current value as a Variant (from raw_metadata or display) or fall back to the legacy string. */
  initialVariant?: Variant;
  initialString: string;
  /** Full metadata for the file (used by LangAltEditor and GpsEditor to gather sibling keys). */
  metadataForFile?: Record<string, Variant>;
  onSave: (edit: DraftEdit) => void;
  onSaveMetadata?: (edit: MetadataDraftEdit) => void;
  /** Multi-tag save, used by GpsEditor and any future paired-tag editor. */
  onSaveBatch?: (edits: Array<{ key: string; edit: DraftEdit }>) => void;
  onSaveMetadataBatch?: (
    edits: Array<{ key: string; edit: MetadataDraftEdit }>,
  ) => void;
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
  onSaveMetadata,
  onSaveBatch,
  onSaveMetadataBatch,
  onCancel,
}: Props) {
  const tag = useTagInfo(propertyKey);
  const readOnly = tag !== null && tag !== "loading" && !tag.writable;
  const saveDraft = (edit: DraftEdit) => {
    if (onSaveMetadata) {
      onSaveMetadata(legacyDraftToMetadataDraft(edit));
    } else {
      onSave(edit);
    }
  };
  const saveMetadataDraft = (edit: MetadataDraftEdit) => {
    if (onSaveMetadata) {
      onSaveMetadata(edit);
    } else {
      onSave(metadataDraftToLegacyDraft(edit));
    }
  };
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
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={
          <EditorMetaHint
            source={
              tag && tag !== "loading"
                ? {
                    kind: "schema",
                    tag,
                    override: "Edited via Flash bitfield helper",
                  }
                : tag === "loading"
                  ? { kind: "loading" }
                  : {
                      kind: "synthetic",
                      label: "EXIF Flash",
                      description:
                        "Bitfield packed into an Integer (see EXIF spec)",
                    }
            }
          />
        }
      />
    );
  }

  // ── Override 2: GPS composite editor (writable only with paired-batch save). ─
  const gpsGroup =
    onSaveBatch || onSaveMetadataBatch ? gpsTagGroup(propertyKey) : null;
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
      typeof altVal === "number"
        ? altVal
        : typeof altVal === "string" && altVal.trim() !== ""
          ? parseFloat(altVal)
          : null;
    return (
      <GpsEditor
        group={gpsGroup}
        initialLatDecimal={parseDecimalDegrees(latVal)}
        initialLatRef={
          parseHemisphere(
            metadataForFile[gpsGroup.latitudeRefKey] ?? latVal,
            "lat",
          ) as "N" | "S"
        }
        initialLonDecimal={parseDecimalDegrees(lonVal)}
        initialLonRef={
          parseHemisphere(
            metadataForFile[gpsGroup.longitudeRefKey] ?? lonVal,
            "lon",
          ) as "E" | "W"
        }
        initialAltitudeMetres={
          Number.isFinite(initialAltitudeMetres as number)
            ? (initialAltitudeMetres as number)
            : null
        }
        initialAltitudeRef={initialAltitudeRef}
        onSave={
          onSaveMetadataBatch
            ? (edits) => onSaveMetadataBatch(edits)
            : (edits) =>
                onSaveBatch?.(
                  edits.map(({ key, edit }) => ({
                    key,
                    edit: metadataDraftToLegacyDraft(edit),
                  })),
                )
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={
          <EditorMetaHint
            source={{
              kind: "synthetic",
              label: "GPS location",
              description:
                "Paired group from ExifTool schema — writes Latitude/Longitude (+ ref) and optional Altitude (+ ref) together",
            }}
          />
        }
      />
    );
  }

  // Shared meta-hint banner — built once per render, threaded into every
  // non-override editor below so the user always sees the same datatype +
  // source line in the same slot.
  const schemaHint = (override?: string) => (
    <EditorMetaHint source={buildSource(tag, override)} />
  );

  if (tag === "loading") {
    // First-call lookup; schema build can take 100-500ms.  Show the legacy
    // text editor so the user isn't blocked.  Switching to a richer editor
    // mid-typing would lose input, so this is a one-render decision.
    return (
      <ValueEditDialog
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={(s) => saveDraft({ value: s, intent: "Set" })}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
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
          onSave={
            onSaveMetadata
              ? (edit) => onSaveMetadata(edit)
              : (edit) => onSave(metadataDraftToLegacyDraft(edit))
          }
          onCancel={onCancel}
          headerHint={schemaHint()}
        />
      );
    }
    // Bag/Seq/Alt of a non-scalar inner (Struct, LangAlt, nested Bag, …).
    // Hands off to the recursive NestedListEditor; each item is edited
    // through TypedValueEditor itself, so arbitrary depth works.
    if (
      (tag.kind.kind === "Bag" ||
        tag.kind.kind === "Seq" ||
        tag.kind.kind === "Alt") &&
      inner === null
    ) {
      const items = initialItemsFromVariant(initialVariant);
      return (
        <NestedListEditor
          propertyKey={propertyKey}
          kind={tag.kind}
          initialItems={items}
          innerEditor={TypedValueEditor}
          onSave={saveMetadataDraft}
          onCancel={onCancel}
          headerHint={schemaHint()}
        />
      );
    }
  }

  if (tag && tag.kind.kind === "Enum") {
    const { repr, options } = tag.kind.data;
    const code = initialCodeFrom(initialVariant, initialString, options);
    return (
      <EnumEditor
        propertyKey={propertyKey}
        repr={repr}
        options={options}
        initialCode={code === "" ? initialString : code}
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
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
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
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
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (tag && tag.kind.kind === "Boolean") {
    const v =
      typeof initialVariant === "boolean"
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
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (
    tag &&
    (tag.kind.kind === "Date" ||
      tag.kind.kind === "Time" ||
      tag.kind.kind === "DateTime")
  ) {
    return (
      <DateTimeEditor
        propertyKey={propertyKey}
        mode={
          tag.kind.kind === "Date"
            ? "date"
            : tag.kind.kind === "Time"
              ? "time"
              : "datetime"
        }
        initialValue={initialString}
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (tag && tag.kind.kind === "LangAlt") {
    const initialLangs = initialLangsFrom(
      initialVariant,
      metadataForFile ?? {},
      propertyKey,
    );
    if (Object.keys(initialLangs).length === 0 && initialString) {
      initialLangs["x-default"] = initialString;
    }
    return (
      <LangAltEditor
        propertyKey={propertyKey}
        initialLangs={initialLangs}
        onSave={
          onSaveMetadata
            ? (edit) => onSaveMetadata(edit)
            : (edit) => onSave(metadataDraftToLegacyDraft(edit))
        }
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
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
        onSave={saveMetadataDraft}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  // ── Phase 8.3: Binary — read-only with explanation. ───────────────────
  if (tag && tag.kind.kind === "Binary") {
    return (
      <div className="dialog-overlay" data-testid="binary-editor-overlay">
        <div className="dialog-content">
          <h3>{propertyKey}</h3>
          {schemaHint()}
          <div className="dialog-body">
            <p className="dialog-hint" data-testid="binary-editor-message">
              This tag holds binary data and is not editable in this app. Use
              ExifTool directly if you need to write it.
            </p>
          </div>
          <div className="dialog-footer">
            <button
              className="dialog-btn dialog-btn-primary"
              onClick={onCancel}
            >
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
  if (
    initialVariant &&
    typeof initialVariant === "object" &&
    !Array.isArray(initialVariant)
  ) {
    return (
      <StructEditor
        propertyKey={propertyKey}
        initialObject={initialObjectFrom(initialVariant)}
        innerEditor={TypedValueEditor}
        onSave={saveMetadataDraft}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint(
          "Routing as Struct because the read value is a nested object",
        )}
      />
    );
  }

  // ── Phase 8.3: Unknown — text input plus a warning. ───────────────────
  if (tag && tag.kind.kind === "Unknown") {
    return (
      <UnknownEditor
        propertyKey={propertyKey}
        initialValue={initialString}
        onSave={(s) => saveDraft({ value: s, intent: "Set" })}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  // Fallback: legacy text input.
  return (
    <ValueEditDialog
      propertyKey={propertyKey}
      initialValue={initialString}
      onSave={(s) => saveDraft({ value: s, intent: "Set" })}
      onCancel={onCancel}
      readOnly={readOnly}
      headerHint={schemaHint()}
    />
  );
}

/** Compute the EditorMetaHint source for the resolved tag-info state. */
function buildSource(
  tag: TagInfo | "loading" | null,
  override?: string,
): EditorMetaSource {
  if (tag === "loading") return { kind: "loading" };
  if (!tag) return { kind: "unknown" };
  return { kind: "schema", tag, override };
}

// Local Unknown-tag editor: same shape as ValueEditDialog but with a banner
// warning the user the schema doesn't describe this tag.  Phase 8.3.
function UnknownEditor({
  propertyKey,
  initialValue,
  onSave,
  onCancel,
  headerHint,
  readOnly,
}: {
  propertyKey: string;
  initialValue: string;
  onSave: (s: string) => void;
  onCancel: () => void;
  headerHint?: React.ReactNode;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      if (!readOnly) onSave(value);
    } else if (e.key === "Escape") onCancel();
  };
  return (
    <div className="dialog-overlay" data-testid="unknown-editor-overlay">
      <div className="dialog-content">
        <h3>Edit {propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
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
          <button
            className="dialog-btn dialog-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={() => onSave(value)}
            disabled={readOnly}
            title={readOnly ? READ_ONLY_TOOLTIP : undefined}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

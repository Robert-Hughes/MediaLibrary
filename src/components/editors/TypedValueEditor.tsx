// Schema-aware editor router.
//
// Picks an editor component based on the tag's TagKind plus a small set of
// explicit editor overrides centralised in
// `src/metadata/tag_overrides.ts`.  See METADATA_FORMATS_DESIGN.md §5 for
// the full table.
//
// Lookup precedence:
//
//   1. Override matchers (Flash, GPS).  These win even
//      against the schema kind because the override editor is materially
//      better than what the schema would produce.
//   2. Schema TagKind.  Drives the regular editor table.
//   3. Struct-shape fallbacks for tags exiftool returns as Object/struct
//      with no schema entry.
//   4. Plain text editor as a last resort.
//
// Two TagKinds exist purely to satisfy design §5:
//   - Unknown — opens a read-only warning dialog so the user can see the
//                raw value of a tag the schema doesn't describe.
//   - Binary  — read-only "binary, not editable in app" message.

import { useTagInfo } from "../../hooks/useTagInfo";
import type {
  MetadataDraftEdit,
  TagInfo,
  TagKind,
  MetadataValue,
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
import { NestedListEditor } from "./NestedListEditor";
import { UnknownEditor } from "./UnknownEditor";
import { TimeOffsetEditor } from "./TimeOffsetEditor";
import {
  initialItemsFrom,
  initialCodeFrom,
  initialLangsFrom,
  gpsNumberFromMetadataValue,
  gpsScalarFromMetadataValue,
  parseHemisphere,
  initialObjectFrom,
  initialItemsFromMetadataValue,
  defaultMetadataValueForKind,
  textInitialString,
  describeKind,
} from "./editorHelpers";

import { gpsMemberGroup, isFlashTag } from "../../metadata/tag_overrides";
import { EditorMetaHint, type EditorMetaSource } from "./EditorMetaHint";
import type { InheritedEditorSchema } from "./editorSchema";

interface Props {
  propertyKey: string;
  initialMetadataValue?: MetadataValue;
  /** Parent-provided schema for synthetic nested paths such as Tag[0]. */
  schemaOverride?: InheritedEditorSchema;
  metadataForFile?: Record<string, MetadataValue>;
  onSaveMetadata: (edit: MetadataDraftEdit) => void;
  /** Multi-tag save, used by GpsEditor and any future paired-tag editor. */
  onSaveMetadataBatch?: (
    edits: Array<{ key: string; edit: MetadataDraftEdit }>,
  ) => void;
  onCancel: () => void;
  editorMode?: "single" | "gps";
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
  initialMetadataValue,
  schemaOverride,
  metadataForFile,
  onSaveMetadata,
  onSaveMetadataBatch,
  onCancel,
  editorMode = "single",
}: Props) {
  const tag = useTagInfo(schemaOverride ? null : propertyKey);
  const kind =
    schemaOverride?.kind ?? (tag && tag !== "loading" ? tag.kind : null);
  const semanticInitial =
    initialMetadataValue ??
    (kind ? defaultMetadataValueForKind(kind) : ({ kind: "Null" } as const));
  const readOnly =
    schemaOverride?.readOnly ??
    (tag !== null && tag !== "loading" && !tag.writable);
  const schemaHint = (override?: string) => (
    <EditorMetaHint
      source={
        schemaOverride
          ? {
              kind: "synthetic",
              label: `${schemaOverride.sourceLabel ?? propertyKey} — ${describeKind(schemaOverride.kind)}`,
              description: `From parent schema${readOnly ? " — read-only" : ""}`,
              readOnly,
            }
          : buildSource(tag, override)
      }
    />
  );
  const saveText = (value: string) => {
    onSaveMetadata({ value: { kind: "Text", value }, intent: "Set" });
  };
  if (semanticInitial.kind === "Unknown") {
    return (
      <UnknownEditor
        propertyKey={propertyKey}
        initialMetadataValue={semanticInitial}
        onCancel={onCancel}
        headerHint={schemaHint()}
      />
    );
  }
  // ── Override 1: Flash bitfield ─────────────────────────────────────────
  if (isFlashTag(propertyKey)) {
    const code = semanticInitial.kind === "Integer" ? semanticInitial.value : 0;
    return (
      <FlashEditor
        propertyKey={propertyKey}
        initialCode={code}
        onSave={onSaveMetadata}
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
  const saveMetadataBatch = onSaveMetadataBatch;
  const gpsGroup =
    editorMode === "gps" && saveMetadataBatch
      ? gpsMemberGroup(propertyKey)
      : null;
  if (gpsGroup && metadataForFile && saveMetadataBatch) {
    const unknownMember = [
      gpsGroup.latitudeKey,
      gpsGroup.latitudeRefKey,
      gpsGroup.longitudeKey,
      gpsGroup.longitudeRefKey,
      gpsGroup.altitudeKey,
      gpsGroup.altitudeRefKey,
    ].find((key) => metadataForFile[key]?.kind === "Unknown");
    if (unknownMember) {
      return (
        <UnknownEditor
          propertyKey={unknownMember}
          initialMetadataValue={metadataForFile[unknownMember]}
          onCancel={onCancel}
          headerHint={schemaHint(
            "GPS composite editing is blocked while a member is unparsed",
          )}
        />
      );
    }
    const latVal = metadataForFile[gpsGroup.latitudeKey];
    const lonVal = metadataForFile[gpsGroup.longitudeKey];
    const altVal = metadataForFile[gpsGroup.altitudeKey];
    const altRefVal = metadataForFile[gpsGroup.altitudeRefKey];
    const latScalar = gpsScalarFromMetadataValue(latVal);
    const lonScalar = gpsScalarFromMetadataValue(lonVal);
    const altRefScalar = gpsScalarFromMetadataValue(altRefVal);

    // exiftool's GPSAltitudeRef is `0` (above) or `1` (below) in raw form;
    // pretty form may render as "Above Sea Level" / "Below Sea Level".
    let initialAltitudeRef: "above" | "below" = "above";
    if (typeof altRefScalar === "number") {
      initialAltitudeRef = altRefScalar === 1 ? "below" : "above";
    } else if (
      typeof altRefScalar === "string" &&
      /below/i.test(altRefScalar)
    ) {
      initialAltitudeRef = "below";
    }
    const initialAltitudeMetres = gpsNumberFromMetadataValue(altVal);
    return (
      <GpsEditor
        group={gpsGroup}
        initialLatDecimal={gpsNumberFromMetadataValue(latVal)}
        initialLatRef={
          parseHemisphere(
            gpsScalarFromMetadataValue(
              metadataForFile[gpsGroup.latitudeRefKey],
            ) ?? latScalar,
            "lat",
          ) as "N" | "S"
        }
        initialLonDecimal={gpsNumberFromMetadataValue(lonVal)}
        initialLonRef={
          parseHemisphere(
            gpsScalarFromMetadataValue(
              metadataForFile[gpsGroup.longitudeRefKey],
            ) ?? lonScalar,
            "lon",
          ) as "E" | "W"
        }
        initialAltitudeMetres={
          Number.isFinite(initialAltitudeMetres as number)
            ? (initialAltitudeMetres as number)
            : null
        }
        initialAltitudeRef={initialAltitudeRef}
        onSave={saveMetadataBatch}
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

  if (tag === "loading") {
    // First-call lookup; schema build can take 100-500ms.  Show the plain
    // text fallback so the user isn't blocked.  Switching to a richer editor
    // mid-typing would lose input, so this is a one-render decision.
    return (
      <ValueEditDialog
        propertyKey={propertyKey}
        initialValue={textInitialString(semanticInitial)}
        onSave={saveText}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind) {
    const inner = bagInnerScalar(kind);
    if (inner) {
      const initialItems = initialItemsFrom(semanticInitial);
      return (
        <BagEditor
          propertyKey={propertyKey}
          initialItems={initialItems}
          ordered={kind.kind === "Seq"}
          innerKind={inner}
          onSave={onSaveMetadata}
          onCancel={onCancel}
          headerHint={schemaHint()}
          readOnly={readOnly}
        />
      );
    }
    // Bag/Seq/Alt of a non-scalar inner (Struct, LangAlt, nested Bag, …).
    // Hands off to the recursive NestedListEditor; each item is edited
    // through TypedValueEditor itself, so arbitrary depth works.
    if (
      (kind.kind === "Bag" || kind.kind === "Seq" || kind.kind === "Alt") &&
      inner === null
    ) {
      const items = initialItemsFromMetadataValue(semanticInitial);
      return (
        <NestedListEditor
          propertyKey={propertyKey}
          kind={kind}
          initialItems={items}
          innerEditor={TypedValueEditor}
          onSave={onSaveMetadata}
          onCancel={onCancel}
          headerHint={schemaHint()}
          readOnly={readOnly}
        />
      );
    }
  }

  if (kind?.kind === "Enum") {
    const { repr, options } = kind.data;
    const code = initialCodeFrom(semanticInitial, options);
    return (
      <EnumEditor
        propertyKey={propertyKey}
        repr={repr}
        options={options}
        initialCode={code}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  // Rational gets a dedicated num/den editor.  Integer / Real
  // continue to use the single-input NumericEditor.
  if (kind?.kind === "Rational") {
    return (
      <RationalEditor
        propertyKey={propertyKey}
        initialMetadataValue={semanticInitial}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind && (kind.kind === "Integer" || kind.kind === "Real")) {
    const min = kind.kind === "Integer" ? kind.data.min : null;
    const max = kind.kind === "Integer" ? kind.data.max : null;
    return (
      <NumericEditor
        propertyKey={propertyKey}
        kind={kind.kind}
        min={min}
        max={max}
        initialMetadataValue={semanticInitial}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind?.kind === "Boolean") {
    const v = semanticInitial.kind === "Bool" ? semanticInitial.value : null;
    return (
      <BooleanEditor
        propertyKey={propertyKey}
        initialValue={v}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (
    kind &&
    (kind.kind === "Date" || kind.kind === "Time" || kind.kind === "DateTime")
  ) {
    return (
      <DateTimeEditor
        propertyKey={propertyKey}
        mode={
          kind.kind === "Date"
            ? "date"
            : kind.kind === "Time"
              ? "time"
              : "datetime"
        }
        initialMetadataValue={semanticInitial}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind?.kind === "TimeOffset") {
    return (
      <TimeOffsetEditor
        propertyKey={propertyKey}
        initialMetadataValue={semanticInitial}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind?.kind === "LangAlt") {
    const initialLangs = initialLangsFrom(
      semanticInitial,
      metadataForFile ?? {},
      propertyKey,
    );
    return (
      <LangAltEditor
        propertyKey={propertyKey}
        initialLangs={initialLangs}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind?.kind === "Struct") {
    const initialObject = initialObjectFrom(semanticInitial);
    return (
      <StructEditor
        propertyKey={propertyKey}
        initialObject={initialObject}
        fieldKinds={kind.data}
        innerEditor={TypedValueEditor}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  // ── Binary — read-only with explanation. ────────────────────────────────
  if (kind?.kind === "Binary") {
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

  // Also route Struct values that come through tags whose schema
  // claims Text — common for tags listx doesn't describe as struct but
  // exiftool's -struct flag has nonetheless delivered as an object.  LangAlt
  // is handled above so we won't intercept Description-style objects here.
  if (semanticInitial.kind === "Struct") {
    return (
      <StructEditor
        propertyKey={propertyKey}
        initialObject={initialObjectFrom(semanticInitial)}
        innerEditor={TypedValueEditor}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint(
          "Routing as Struct because the read value is a nested object",
        )}
      />
    );
  }

  // ── Unknown — read-only warning dialog. ────────────────────────────────
  if (kind?.kind === "Unknown") {
    return (
      <UnknownEditor
        propertyKey={propertyKey}
        initialMetadataValue={semanticInitial}
        onCancel={onCancel}
        headerHint={schemaHint()}
      />
    );
  }

  // Fallback: plain text editor for Text-kind or unrecognised tags.
  return (
    <ValueEditDialog
      propertyKey={propertyKey}
      initialValue={textInitialString(semanticInitial)}
      onSave={saveText}
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

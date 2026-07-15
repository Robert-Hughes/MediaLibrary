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

import { useTagInfo, useTagInfos } from "../../hooks/useTagInfo";
import { ModalDialog } from "../ModalDialog";
import type {
  MetadataDraftEdit,
  TagInfo,
  TagKind,
  MetadataValue,
  SchemaDefinitionId,
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
import {
  metadataGet,
  type MetadataCollection,
} from "../../utils/metadataCollection";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdToken,
  tagInfoDisplayName,
} from "../../utils/schemaDefinitionId";

interface Props {
  /** Exact top-level metadata identity; null only for synthetic nested values. */
  propertyId: SchemaDefinitionId | null;
  propertyLabel?: string;
  initialMetadataValue?: MetadataValue;
  /** Parent-provided schema for synthetic nested paths such as Tag[0]. */
  schemaOverride?: InheritedEditorSchema;
  metadataForFile?: MetadataCollection;
  /** Shared map/geocode GPS resolution, used to initialise the GPS editor. */
  effectiveGps?: { lat: number | null; lon: number | null };
  onSaveMetadata: (edit: MetadataDraftEdit) => void;
  /** Multi-tag save, used by GpsEditor and any future paired-tag editor. */
  onSaveMetadataBatch?: (
    edits: Array<{ id: SchemaDefinitionId; edit: MetadataDraftEdit }>,
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

function enumKindFromTagInfo(
  tag: TagInfo | "loading" | null | undefined,
): Extract<TagKind, { kind: "Enum" }> | undefined {
  return tag && tag !== "loading" && tag.kind.kind === "Enum"
    ? tag.kind
    : undefined;
}

function coordinateIsNegative(value: number): boolean {
  return value < 0 || Object.is(value, -0);
}

export function TypedValueEditor({
  propertyId,
  propertyLabel: suppliedPropertyLabel,
  initialMetadataValue,
  schemaOverride,
  metadataForFile,
  effectiveGps,
  onSaveMetadata,
  onSaveMetadataBatch,
  onCancel,
  editorMode = "single",
}: Props) {
  const tag = useTagInfo(schemaOverride ? null : propertyId);
  const propertyLabel =
    suppliedPropertyLabel ??
    (tag && tag !== "loading"
      ? tagInfoDisplayName(tag)
      : propertyId
        ? formatSchemaDefinitionIdForDiagnostics(propertyId)
        : "Nested value");
  const gpsSchemaGroup =
    editorMode === "gps" && propertyId ? gpsMemberGroup(propertyId) : null;
  const gpsTagInfos = useTagInfos(
    gpsSchemaGroup
      ? [
          gpsSchemaGroup.latitudeRefId,
          gpsSchemaGroup.longitudeRefId,
          gpsSchemaGroup.altitudeRefId,
        ]
      : [],
  );
  const kind =
    schemaOverride?.kind ?? (tag && tag !== "loading" ? tag.kind : null);
  const semanticInitial =
    initialMetadataValue ??
    (kind ? defaultMetadataValueForKind(kind) : ({ kind: "Null" } as const));
  const readOnly =
    schemaOverride?.readOnly ??
    (propertyId !== null &&
      (tag === null || tag === "loading" || !tag.writable));
  const schemaHint = (override?: string) => (
    <EditorMetaHint
      source={
        schemaOverride
          ? {
              kind: "synthetic",
              label: `${schemaOverride.sourceLabel ?? propertyLabel} — ${describeKind(schemaOverride.kind)}`,
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
        propertyKey={propertyLabel}
        initialMetadataValue={semanticInitial}
        onCancel={onCancel}
        headerHint={schemaHint()}
      />
    );
  }
  // ── Override 1: Flash bitfield ─────────────────────────────────────────
  if (propertyId && isFlashTag(propertyId)) {
    const code = semanticInitial.kind === "Integer" ? semanticInitial.value : 0;
    return (
      <FlashEditor
        propertyKey={propertyLabel}
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
    editorMode === "gps" && saveMetadataBatch ? gpsSchemaGroup : null;
  const canUseCompositeGpsEditor =
    gpsGroup &&
    metadataForFile &&
    saveMetadataBatch &&
    ![
      gpsGroup.latitudeId,
      gpsGroup.latitudeRefId,
      gpsGroup.longitudeId,
      gpsGroup.longitudeRefId,
      gpsGroup.altitudeId,
      gpsGroup.altitudeRefId,
    ].some((id) => metadataGet(metadataForFile, id)?.kind === "Unknown");
  if (canUseCompositeGpsEditor) {
    const latVal = metadataGet(metadataForFile, gpsGroup.latitudeId);
    const lonVal = metadataGet(metadataForFile, gpsGroup.longitudeId);
    const altVal = metadataGet(metadataForFile, gpsGroup.altitudeId);
    const altRefVal = metadataGet(metadataForFile, gpsGroup.altitudeRefId);
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
    const initialLatDecimal = effectiveGps
      ? effectiveGps.lat === null
        ? null
        : Math.abs(effectiveGps.lat)
      : gpsNumberFromMetadataValue(latVal);
    const initialLonDecimal = effectiveGps
      ? effectiveGps.lon === null
        ? null
        : Math.abs(effectiveGps.lon)
      : gpsNumberFromMetadataValue(lonVal);
    return (
      <GpsEditor
        group={gpsGroup}
        initialLatDecimal={initialLatDecimal}
        initialLatRef={
          effectiveGps?.lat !== null && effectiveGps?.lat !== undefined
            ? coordinateIsNegative(effectiveGps.lat)
              ? "S"
              : "N"
            : (parseHemisphere(
                gpsScalarFromMetadataValue(
                  metadataGet(metadataForFile, gpsGroup.latitudeRefId),
                ) ?? latScalar,
                "lat",
              ) as "N" | "S")
        }
        initialLonDecimal={initialLonDecimal}
        initialLonRef={
          effectiveGps?.lon !== null && effectiveGps?.lon !== undefined
            ? coordinateIsNegative(effectiveGps.lon)
              ? "W"
              : "E"
            : (parseHemisphere(
                gpsScalarFromMetadataValue(
                  metadataGet(metadataForFile, gpsGroup.longitudeRefId),
                ) ?? lonScalar,
                "lon",
              ) as "E" | "W")
        }
        initialAltitudeMetres={
          Number.isFinite(initialAltitudeMetres as number)
            ? (initialAltitudeMetres as number)
            : null
        }
        initialAltitudeRef={initialAltitudeRef}
        refKinds={{
          latitude: enumKindFromTagInfo(
            gpsTagInfos[schemaDefinitionIdToken(gpsGroup.latitudeRefId)],
          ),
          longitude: enumKindFromTagInfo(
            gpsTagInfos[schemaDefinitionIdToken(gpsGroup.longitudeRefId)],
          ),
          altitude: enumKindFromTagInfo(
            gpsTagInfos[schemaDefinitionIdToken(gpsGroup.altitudeRefId)],
          ),
        }}
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
    // read-only placeholder while the exact schema lookup is in flight.
    return (
      <ValueEditDialog
        propertyKey={propertyLabel}
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
          propertyKey={propertyLabel}
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
          propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
        initialMetadataValue={semanticInitial}
        onSave={onSaveMetadata}
        onCancel={onCancel}
        readOnly={readOnly}
        headerHint={schemaHint()}
      />
    );
  }

  if (kind?.kind === "LangAlt") {
    const initialLangs = initialLangsFrom(semanticInitial);
    return (
      <LangAltEditor
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
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
      <ModalDialog
        open
        onDismiss={onCancel}
        testId="binary-editor-overlay"
        aria-label={propertyLabel}
      >
        <div className="dialog-content">
          <h3>{propertyLabel}</h3>
          {schemaHint()}
          <div className="dialog-body">
            <p className="dialog-hint" data-testid="binary-editor-message">
              This tag holds binary data and is not editable in this app. Use
              ExifTool directly if you need to write it.
            </p>
          </div>
          <div className="dialog-footer">
            <button
              type="button"
              autoFocus
              className="dialog-btn dialog-btn-primary"
              onClick={onCancel}
            >
              Close
            </button>
          </div>
        </div>
      </ModalDialog>
    );
  }

  // Also route Struct values that come through tags whose schema
  // claims Text — common for tags listx doesn't describe as struct but
  // exiftool's -struct flag has nonetheless delivered as an object.  LangAlt
  // is handled above so we won't intercept Description-style objects here.
  if (semanticInitial.kind === "Struct") {
    return (
      <StructEditor
        propertyKey={propertyLabel}
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
        propertyKey={propertyLabel}
        initialMetadataValue={semanticInitial}
        onCancel={onCancel}
        headerHint={schemaHint()}
      />
    );
  }

  // Text schema uses the plain editor. Missing top-level schemas are read-only.
  return (
    <ValueEditDialog
      propertyKey={propertyLabel}
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

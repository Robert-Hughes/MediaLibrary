/**
 * Build the per-image input bundles passed to `normalise_metadata_cmd`.
 *
 * For each selected photo, resolve the draft-overlay (draft beats
 * metadata — plan §3) across every tag relevant to the enabled
 * groups, and pack the resolved values into the typed
 * `NormaliseRequestItem` shape the backend expects.
 *
 * The backend never reads the typed-draft JSONL during a run; the
 * front end is the source of truth while the app is running. See
 * `docs/NORMALISE_METADATA_PLAN.md` §3 / §8 for the rationale.
 */
import type {
  ImageMetadataEntry,
  ImageMetadataStore,
  MetadataValue,
  NormaliseGroup,
  NormaliseRequestItem,
  MetadataDraftCollection,
  MetadataDraftEditsByFile,
  SchemaDefinitionId,
} from "../types";
import { metadataValueToDisplayString } from "../draft";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import { metadataGet, type MetadataCollection } from "./metadataCollection";
import { schemaDefinitionIdToken } from "./schemaDefinitionId";

/** Per-file shape of the draft store snapshot. */
export type DraftEditsByFile = MetadataDraftEditsByFile;

type EffectiveMetadataEntry = MetadataValue | null;

function metadataValueOnly(
  entry: ImageMetadataEntry | undefined,
): MetadataValue | null {
  if (!entry) return null;
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

/** Read a single tag with draft-overlay precedence. Returns the
 *  effective metadata value, or `null` when the tag is deleted-as-
 *  draft OR absent on both sides. */
export function resolveTag(
  metadata: MetadataCollection | undefined,
  drafts: MetadataDraftCollection | undefined,
  id: SchemaDefinitionId,
): EffectiveMetadataEntry {
  const draft = drafts?.[schemaDefinitionIdToken(id)]?.edit;
  if (draft) {
    if (draft.intent === "Delete") return null;
    if (draft.intent === "Set") return draft.value ?? null;
    // ListAdd / ListRemove require knowing the base — we conservatively
    // fall through to the metadata value when applied on top would be
    // ambiguous. Group normalisers don't currently emit these intents.
    return metadata ? metadataValueOnly(metadataGet(metadata, id)) : null;
  }
  return metadata ? metadataValueOnly(metadataGet(metadata, id)) : null;
}

export function buildEffectiveMetadata(
  metadata: MetadataCollection,
  drafts: MetadataDraftCollection | undefined,
): MetadataCollection {
  const effective: MetadataCollection = {};
  for (const key of new Set([
    ...Object.keys(metadata),
    ...Object.keys(drafts ?? {}),
  ])) {
    const entry = metadata[key] ?? drafts?.[key];
    const id = entry && "id" in entry ? entry.id : undefined;
    if (!id) continue;
    const value = resolveTag(metadata, drafts, id);
    if (isMetadataValue(value))
      effective[key] = { ...value, id } as ImageMetadataEntry;
  }
  return effective;
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

function metadataEntryToString(v: EffectiveMetadataEntry): string | null {
  if (v == null) return null;
  if (isMetadataValue(v)) {
    if (v.kind === "LangAlt") {
      return v.value["x-default"] ?? Object.values(v.value)[0] ?? null;
    }
    if (v.kind === "Text") return v.value;
    if (
      v.kind === "Bool" ||
      v.kind === "Integer" ||
      v.kind === "Real" ||
      v.kind === "Rational" ||
      v.kind === "Date" ||
      v.kind === "Time" ||
      v.kind === "DateTime" ||
      v.kind === "TimeOffset"
    ) {
      return metadataValueToDisplayString(v);
    }
    return null;
  }
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // For scalar tags we don't expect lists / objects; null out so the
  // backend treats this as absent rather than silently coercing.
  return null;
}

function metadataEntryToStringList(v: EffectiveMetadataEntry): string[] {
  if (v == null) return [];
  if (isMetadataValue(v) && v.kind === "List") {
    const out: string[] = [];
    for (const item of v.value.items) {
      const s = metadataEntryToString(item);
      if (s != null && s !== "") out.push(s);
    }
    return out;
  }
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = metadataEntryToString(item);
      if (s != null && s !== "") out.push(s);
    }
    return out;
  }
  // Scalar value where a list was expected — promote to single-element
  // list when the value is a non-empty string. Mirrors how exiftool
  // sometimes emits a single-entry Bag as a scalar string.
  const s = metadataEntryToString(v);
  return s != null && s !== "" ? [s] : [];
}

/** Photo data passed into the resolver — kept narrow so callers can
 *  pull either the React `ImageMetadataStore` or a plain object map. */
export interface PhotoMetadataLookup {
  get(relPath: string): MetadataCollection | undefined;
}

/** Adapt the live `ImageMetadataStore` to the `PhotoMetadataLookup`
 *  shape used here. */
export function metadataStoreLookup(
  store: ImageMetadataStore,
): PhotoMetadataLookup {
  return {
    get(relPath) {
      const m = store.get(relPath);
      if (typeof m === "object" && m !== null) {
        return m;
      }
      return undefined;
    },
  };
}

/** Strip a path's stem from its rel path so filename fallback (Group
 *  H) has a sensible key. */
function fileStemOf(relPath: string): string {
  const slash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const base = slash >= 0 ? relPath.substring(slash + 1) : relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.substring(0, dot) : base;
}

/** Helper that resolves a scalar tag to `Option<String>` — returns
 *  `null` (mapped to `undefined` in TS for `serde(skip_if_none)`) when
 *  the tag is absent / deleted / empty. */
function scalar(
  metadata: MetadataCollection | undefined,
  drafts: MetadataDraftCollection | undefined,
  id: SchemaDefinitionId,
): string | undefined {
  const s = metadataEntryToString(resolveTag(metadata, drafts, id));
  if (s == null) return undefined;
  return s;
}

function scalarValue(
  metadata: MetadataCollection | undefined,
  drafts: MetadataDraftCollection | undefined,
  id: SchemaDefinitionId,
): MetadataValue | undefined {
  const value = resolveTag(metadata, drafts, id);
  return isMetadataValue(value) ? value : undefined;
}

/** Helper that resolves a list tag to `Vec<String>`. */
function list(
  metadata: MetadataCollection | undefined,
  drafts: MetadataDraftCollection | undefined,
  id: SchemaDefinitionId,
): string[] {
  return metadataEntryToStringList(resolveTag(metadata, drafts, id));
}

/**
 * Build the per-image input bundle for one photo.
 *
 * Exported separately so tests can exercise the per-photo path
 * without standing up an ImageMetadataStore.
 */
export function buildNormaliseItemForPhoto(
  relPath: string,
  metadata: MetadataCollection | undefined,
  drafts: MetadataDraftCollection | undefined,
  enabledGroups: ReadonlyArray<NormaliseGroup>,
): NormaliseRequestItem {
  const groupSet = new Set(enabledGroups);

  const groupInputs: NormaliseRequestItem["groupInputs"] = {
    keywords: null,
    creator: null,
    copyright: null,
    headline: null,
    title: null,
    location: null,
    dates: null,
    description: null,
  };

  if (groupSet.has("keywords")) {
    groupInputs.keywords = {
      hierarchicalSubject: list(metadata, drafts, ID.xmpHierarchicalSubject),
      dcSubject: list(metadata, drafts, ID.xmpSubject),
      iptcKeywords: list(metadata, drafts, ID.iptcKeywords),
      aiTags: list(metadata, drafts, ID.mlibAiTags),
      aiObjects: list(metadata, drafts, ID.mlibAiObjects),
    };
  }

  if (groupSet.has("creator")) {
    groupInputs.creator = {
      creator: list(metadata, drafts, ID.xmpCreator),
      artist: scalar(metadata, drafts, ID.artist) ?? null,
      byline: list(metadata, drafts, ID.iptcByLine),
    };
  }

  if (groupSet.has("copyright")) {
    groupInputs.copyright = {
      rights: scalar(metadata, drafts, ID.xmpRights) ?? null,
      exifCopyright: scalar(metadata, drafts, ID.copyright) ?? null,
      iptcCopyright: scalar(metadata, drafts, ID.iptcCopyright) ?? null,
    };
  }

  if (groupSet.has("headline")) {
    groupInputs.headline = {
      photoshopHeadline: scalar(metadata, drafts, ID.xmpHeadline) ?? null,
      iptcHeadline: scalar(metadata, drafts, ID.iptcHeadline) ?? null,
    };
  }

  if (groupSet.has("title")) {
    groupInputs.title = {
      title: scalar(metadata, drafts, ID.xmpTitle) ?? null,
      objectName: scalar(metadata, drafts, ID.iptcObjectName) ?? null,
      // Pass-2 + pass-3 dispatcher populates these from Group B / F /
      // A canonicals; frontend always leaves them empty.
      descriptionCanonical: null,
      locationContext: null,
      keywordsContext: [],
    };
  }

  if (groupSet.has("location")) {
    groupInputs.location = {
      locationXmp: scalar(metadata, drafts, ID.xmpLocation) ?? null,
      locationIptc: scalar(metadata, drafts, ID.iptcSubLocation) ?? null,
      cityXmp: scalar(metadata, drafts, ID.xmpCity) ?? null,
      cityIptc: scalar(metadata, drafts, ID.iptcCity) ?? null,
      stateXmp: scalar(metadata, drafts, ID.xmpState) ?? null,
      stateIptc: scalar(metadata, drafts, ID.iptcProvinceState) ?? null,
      countryXmp: scalar(metadata, drafts, ID.xmpCountry) ?? null,
      countryIptc: scalar(metadata, drafts, ID.iptcCountryName) ?? null,
      countryCodeXmp: scalar(metadata, drafts, ID.xmpCountryCode) ?? null,
      countryCodeIptc: scalar(metadata, drafts, ID.iptcCountryCode) ?? null,
    };
  }

  if (groupSet.has("description")) {
    groupInputs.description = {
      description: scalar(metadata, drafts, ID.xmpDescription) ?? null,
      imageDescription: scalar(metadata, drafts, ID.imageDescription) ?? null,
      captionAbstract: scalar(metadata, drafts, ID.iptcCaption) ?? null,
      iptcCharsetIsUtf8:
        scalar(metadata, drafts, ID.iptcCodedCharacterSet) === "UTF8" ||
        scalar(metadata, drafts, ID.iptcCodedCharacterSet) === "%G",
      aiDescription: scalar(metadata, drafts, ID.mlibAiDescription) ?? null,
      aiInterpretation:
        scalar(metadata, drafts, ID.mlibAiInterpretation) ?? null,
      aiOcrText: list(metadata, drafts, ID.mlibAiOcrText),
      aiObjects: list(metadata, drafts, ID.mlibAiObjects),
      // location / keywords / date context are populated by the
      // backend dispatcher from the Pass-1 outputs, not the frontend.
      locationContext: null,
      keywordsContext: [],
      dateContext: null,
    };
  }

  if (groupSet.has("dates")) {
    groupInputs.dates = {
      dateTimeOriginal:
        scalarValue(metadata, drafts, ID.dateTimeOriginal) ?? null,
      offsetTimeOriginal:
        scalarValue(metadata, drafts, ID.offsetTimeOriginal) ?? null,
      subSecTimeOriginal:
        scalarValue(metadata, drafts, ID.subSecTimeOriginal) ?? null,
      photoshopDateCreated:
        scalarValue(metadata, drafts, ID.xmpDateCreated) ?? null,
      iptcDateCreated:
        scalarValue(metadata, drafts, ID.iptcDateCreated) ?? null,
      iptcTimeCreated:
        scalarValue(metadata, drafts, ID.iptcTimeCreated) ?? null,
      createDate: scalarValue(metadata, drafts, ID.createDate) ?? null,
      offsetTimeDigitized:
        scalarValue(metadata, drafts, ID.offsetTimeDigitized) ?? null,
      offsetTime: scalarValue(metadata, drafts, ID.offsetTime) ?? null,
      subSecTimeDigitized:
        scalarValue(metadata, drafts, ID.subSecTimeDigitized) ?? null,
      xmpCreateDate: scalarValue(metadata, drafts, ID.xmpCreateDate) ?? null,
      iptcDigitalCreationDate:
        scalarValue(metadata, drafts, ID.iptcDigitalCreationDate) ?? null,
      iptcDigitalCreationTime:
        scalarValue(metadata, drafts, ID.iptcDigitalCreationTime) ?? null,
      fileStem: fileStemOf(relPath),
    };
  }

  return { relPath, groupInputs };
}

/**
 * Build the full batch payload — one `NormaliseRequestItem` per
 * selected photo.
 */
export function buildNormaliseItems(
  relPaths: ReadonlyArray<string>,
  metadata: PhotoMetadataLookup,
  drafts: DraftEditsByFile,
  enabledGroups: ReadonlyArray<NormaliseGroup>,
): NormaliseRequestItem[] {
  return relPaths.map((rel) =>
    buildNormaliseItemForPhoto(
      rel,
      metadata.get(rel),
      drafts[rel],
      enabledGroups,
    ),
  );
}

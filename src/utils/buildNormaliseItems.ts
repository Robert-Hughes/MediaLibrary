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
import type { DraftEdit, ImageMetadataStore, NormaliseGroup, NormaliseRequestItem, Variant } from "../types";

/** Per-file shape of the draft store snapshot. */
export type DraftEditsByFile = Record<string, Record<string, DraftEdit> | undefined>;

/** Read a single tag with draft-overlay precedence. Returns the
 *  effective `Variant` value, or `null` when the tag is deleted-as-
 *  draft OR absent on both sides. */
export function resolveTag(
  metadata: Record<string, Variant> | undefined,
  drafts: Record<string, DraftEdit> | undefined,
  key: string,
): Variant | null {
  const draft = drafts?.[key];
  if (draft) {
    if (draft.intent === "Delete") return null;
    if (draft.intent === "Set") return draft.value ?? null;
    // ListAdd / ListRemove require knowing the base — we conservatively
    // fall through to the metadata value when applied on top would be
    // ambiguous. Group normalisers don't currently emit these intents.
    return metadata?.[key] ?? null;
  }
  return metadata?.[key] ?? null;
}

function variantToString(v: Variant | null): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  // For scalar tags we don't expect lists / objects; null out so the
  // backend treats this as absent rather than silently coercing.
  return null;
}

function variantToStringList(v: Variant | null): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    const out: string[] = [];
    for (const item of v) {
      const s = variantToString(item);
      if (s != null && s !== "") out.push(s);
    }
    return out;
  }
  // Scalar value where a list was expected — promote to single-element
  // list when the value is a non-empty string. Mirrors how exiftool
  // sometimes emits a single-entry Bag as a scalar string.
  const s = variantToString(v);
  return s != null && s !== "" ? [s] : [];
}

/** Photo data passed into the resolver — kept narrow so callers can
 *  pull either the React `ImageMetadataStore` or a plain object map. */
export interface PhotoMetadataLookup {
  get(relPath: string): Record<string, Variant> | undefined;
}

/** Adapt the live `ImageMetadataStore` to the `PhotoMetadataLookup`
 *  shape used here. */
export function metadataStoreLookup(store: ImageMetadataStore): PhotoMetadataLookup {
  return {
    get(relPath) {
      const m = store.get(relPath);
      if (typeof m === "object" && m !== null) {
        return m as Record<string, Variant>;
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
  metadata: Record<string, Variant> | undefined,
  drafts: Record<string, DraftEdit> | undefined,
  key: string,
): string | undefined {
  const s = variantToString(resolveTag(metadata, drafts, key));
  if (s == null) return undefined;
  return s;
}

/** Helper that resolves a list tag to `Vec<String>`. */
function list(
  metadata: Record<string, Variant> | undefined,
  drafts: Record<string, DraftEdit> | undefined,
  key: string,
): string[] {
  return variantToStringList(resolveTag(metadata, drafts, key));
}

/**
 * Build the per-image input bundle for one photo.
 *
 * Exported separately so tests can exercise the per-photo path
 * without standing up an ImageMetadataStore.
 */
export function buildNormaliseItemForPhoto(
  relPath: string,
  metadata: Record<string, Variant> | undefined,
  drafts: Record<string, DraftEdit> | undefined,
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
      hierarchicalSubject: list(metadata, drafts, "XMP-lr:HierarchicalSubject"),
      dcSubject: list(metadata, drafts, "XMP-dc:Subject"),
      iptcKeywords: list(metadata, drafts, "IPTC:Keywords"),
      aiTags: list(metadata, drafts, "XMP-mlib:AITags"),
      aiObjects: list(metadata, drafts, "XMP-mlib:AIObjects"),
    };
  }

  if (groupSet.has("creator")) {
    groupInputs.creator = {
      creator: list(metadata, drafts, "XMP-dc:Creator"),
      artist: scalar(metadata, drafts, "EXIF:Artist") ?? null,
      byline: list(metadata, drafts, "IPTC:By-line"),
    };
  }

  if (groupSet.has("copyright")) {
    groupInputs.copyright = {
      rights: scalar(metadata, drafts, "XMP-dc:Rights") ?? null,
      exifCopyright: scalar(metadata, drafts, "EXIF:Copyright") ?? null,
      iptcCopyright: scalar(metadata, drafts, "IPTC:CopyrightNotice") ?? null,
    };
  }

  if (groupSet.has("headline")) {
    groupInputs.headline = {
      photoshopHeadline: scalar(metadata, drafts, "XMP-photoshop:Headline") ?? null,
      iptcHeadline: scalar(metadata, drafts, "IPTC:Headline") ?? null,
    };
  }

  if (groupSet.has("title")) {
    groupInputs.title = {
      title: scalar(metadata, drafts, "XMP-dc:Title") ?? null,
      objectName: scalar(metadata, drafts, "IPTC:ObjectName") ?? null,
      // Pass-2 + pass-3 dispatcher populates these from Group B / F /
      // A canonicals; frontend always leaves them empty.
      descriptionCanonical: null,
      locationContext: null,
      keywordsContext: [],
    };
  }

  if (groupSet.has("location")) {
    groupInputs.location = {
      locationXmp: scalar(metadata, drafts, "XMP-iptcCore:Location") ?? null,
      locationIptc: scalar(metadata, drafts, "IPTC:Sub-location") ?? null,
      cityXmp: scalar(metadata, drafts, "XMP-photoshop:City") ?? null,
      cityIptc: scalar(metadata, drafts, "IPTC:City") ?? null,
      stateXmp: scalar(metadata, drafts, "XMP-photoshop:State") ?? null,
      stateIptc: scalar(metadata, drafts, "IPTC:Province-State") ?? null,
      countryXmp: scalar(metadata, drafts, "XMP-photoshop:Country") ?? null,
      countryIptc: scalar(metadata, drafts, "IPTC:Country-PrimaryLocationName") ?? null,
      countryCodeXmp: scalar(metadata, drafts, "XMP-iptcCore:CountryCode") ?? null,
      countryCodeIptc: scalar(metadata, drafts, "IPTC:Country-PrimaryLocationCode") ?? null,
    };
  }

  if (groupSet.has("description")) {
    groupInputs.description = {
      description: scalar(metadata, drafts, "XMP-dc:Description") ?? null,
      imageDescription: scalar(metadata, drafts, "EXIF:ImageDescription") ?? null,
      captionAbstract: scalar(metadata, drafts, "IPTC:Caption-Abstract") ?? null,
      iptcCharsetIsUtf8:
        scalar(metadata, drafts, "IPTC:CodedCharacterSet") === "UTF8" ||
        scalar(metadata, drafts, "IPTC:CodedCharacterSet") === "%G",
      aiDescription: scalar(metadata, drafts, "XMP-mlib:AIDescription") ?? null,
      aiInterpretation: scalar(metadata, drafts, "XMP-mlib:AIInterpretation") ?? null,
      aiOcrText: list(metadata, drafts, "XMP-mlib:AIOcrText"),
      aiObjects: list(metadata, drafts, "XMP-mlib:AIObjects"),
      // location / keywords / date context are populated by the
      // backend dispatcher from the Pass-1 outputs, not the frontend.
      locationContext: null,
      keywordsContext: [],
      dateContext: null,
    };
  }

  if (groupSet.has("dates")) {
    groupInputs.dates = {
      dateTimeOriginal: scalar(metadata, drafts, "EXIF:DateTimeOriginal") ?? null,
      offsetTimeOriginal: scalar(metadata, drafts, "EXIF:OffsetTimeOriginal") ?? null,
      subSecTimeOriginal: scalar(metadata, drafts, "EXIF:SubSecTimeOriginal") ?? null,
      photoshopDateCreated: scalar(metadata, drafts, "XMP-photoshop:DateCreated") ?? null,
      iptcDateCreated: scalar(metadata, drafts, "IPTC:DateCreated") ?? null,
      iptcTimeCreated: scalar(metadata, drafts, "IPTC:TimeCreated") ?? null,
      createDate: scalar(metadata, drafts, "EXIF:CreateDate") ?? null,
      offsetTime: scalar(metadata, drafts, "EXIF:OffsetTime") ?? null,
      subSecTimeDigitized: scalar(metadata, drafts, "EXIF:SubSecTimeDigitized") ?? null,
      xmpCreateDate: scalar(metadata, drafts, "XMP-xmp:CreateDate") ?? null,
      iptcDigitalCreationDate: scalar(metadata, drafts, "IPTC:DigitalCreationDate") ?? null,
      iptcDigitalCreationTime: scalar(metadata, drafts, "IPTC:DigitalCreationTime") ?? null,
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
    buildNormaliseItemForPhoto(rel, metadata.get(rel), drafts[rel], enabledGroups),
  );
}

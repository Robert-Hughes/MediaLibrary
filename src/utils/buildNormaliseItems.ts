/** Build the target-aware per-image input bundles for metadata normalisation. */
import type {
  TargetDraftCollection,
  TargetDraftEditsByFile,
} from "../targetDraftEdits";
import type {
  FileMetadataEntry,
  FileMetadataOccurrencesState,
  FileMetadataOccurrencesStore,
  MetadataValue,
  NormaliseGroup,
  NormaliseRequestItem,
  SchemaDefinitionId,
} from "../types";
import { formatMetadataValue } from "../draft";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import { buildEffectiveMetadataForFile } from "./effectiveMetadata";
import {
  metadataEntries,
  metadataGet,
  type MetadataCollection,
} from "./metadataCollection";
import { resolveGps } from "./resolveGps";
import { filterGeneratedMetadataDestinationView } from "./generatedMetadataDestination";

type EffectiveMetadataEntry = MetadataValue | null;

function metadataValueOnly(
  entry: FileMetadataEntry | undefined,
): MetadataValue | null {
  if (!entry) return null;
  const { id: _id, ...value } = entry;
  return value as MetadataValue;
}

function readEffectiveTag(
  metadata: MetadataCollection | undefined,
  id: SchemaDefinitionId,
): EffectiveMetadataEntry {
  return metadata ? metadataValueOnly(metadataGet(metadata, id)) : null;
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
    return formatMetadataValue({ value: v });
  }
  return null;
}

function metadataEntryToStringList(v: EffectiveMetadataEntry): string[] {
  if (v == null) return [];
  if (v.kind === "List") {
    return v.value.items
      .map(metadataEntryToString)
      .filter((item): item is string => item != null && item !== "");
  }
  const scalar = metadataEntryToString(v);
  return scalar != null && scalar !== "" ? [scalar] : [];
}

export interface FileOccurrencesLookup {
  get(relPath: string): FileMetadataOccurrencesState | undefined;
}

export function metadataOccurrencesStoreLookup(
  store: FileMetadataOccurrencesStore,
): FileOccurrencesLookup {
  return { get: (relPath) => store.get(relPath) };
}

function fileStemOf(relPath: string): string {
  const slash = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  const base = slash >= 0 ? relPath.substring(slash + 1) : relPath;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.substring(0, dot) : base;
}

function scalar(
  metadata: MetadataCollection | undefined,
  id: SchemaDefinitionId,
): string | undefined {
  return metadataEntryToString(readEffectiveTag(metadata, id)) ?? undefined;
}

function scalarValue(
  metadata: MetadataCollection | undefined,
  id: SchemaDefinitionId,
): MetadataValue | undefined {
  const value = readEffectiveTag(metadata, id);
  return isMetadataValue(value) ? value : undefined;
}

function real(
  metadata: MetadataCollection | undefined,
  id: SchemaDefinitionId,
): number | undefined {
  const value = readEffectiveTag(metadata, id);
  if (value?.kind === "Real" || value?.kind === "Integer") {
    return value.value;
  }
  return undefined;
}

function list(
  metadata: MetadataCollection | undefined,
  id: SchemaDefinitionId,
): string[] {
  return metadataEntryToStringList(readEffectiveTag(metadata, id));
}

/**
 * Build one normalise item from the same target-aware effective metadata view
 * shown to the user.
 */
export function buildNormaliseItemForFile(
  relPath: string,
  enabledGroups: ReadonlyArray<NormaliseGroup>,
  occurrences?: FileMetadataOccurrencesState,
  targetDrafts?: TargetDraftCollection,
): NormaliseRequestItem {
  const effective = buildEffectiveMetadataForFile(
    filterGeneratedMetadataDestinationView({
      occurrences,
      targetDrafts,
    }),
  );
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
    iptcUtf8: null,
  };

  if (groupSet.has("keywords")) {
    groupInputs.keywords = {
      hierarchicalSubject: list(effective, ID.xmpHierarchicalSubject),
      dcSubject: list(effective, ID.xmpSubject),
      iptcKeywords: list(effective, ID.iptcKeywords),
      aiTags: list(effective, ID.mlibAiTags),
      aiObjects: list(effective, ID.mlibAiObjects),
    };
  }

  if (groupSet.has("creator")) {
    groupInputs.creator = {
      creator: list(effective, ID.xmpCreator),
      artist: scalar(effective, ID.artist) ?? null,
      byline: list(effective, ID.iptcByLine),
    };
  }

  if (groupSet.has("copyright")) {
    groupInputs.copyright = {
      rights: scalar(effective, ID.xmpRights) ?? null,
      exifCopyright: scalar(effective, ID.copyright) ?? null,
      iptcCopyright: scalar(effective, ID.iptcCopyright) ?? null,
    };
  }

  if (groupSet.has("headline")) {
    groupInputs.headline = {
      photoshopHeadline: scalar(effective, ID.xmpHeadline) ?? null,
      iptcHeadline: scalar(effective, ID.iptcHeadline) ?? null,
    };
  }

  if (groupSet.has("title")) {
    groupInputs.title = {
      title: scalar(effective, ID.xmpTitle) ?? null,
      objectName: scalar(effective, ID.iptcObjectName) ?? null,
      descriptionCanonical: null,
      locationContext: null,
      keywordsContext: [],
    };
  }

  if (groupSet.has("location")) {
    // Use the same GPS resolver as maps and reverse geocoding so EXIF
    // hemisphere references (notably W/S) are applied consistently.
    const gps = resolveGps(undefined, effective);
    groupInputs.location = {
      locationCreated: scalarValue(effective, ID.xmpLocationCreated) ?? null,
      geocodeJson: scalar(effective, ID.mlibReverseGeocodeGeocodeJson) ?? null,
      jsonV2: scalar(effective, ID.mlibReverseGeocodeJsonV2) ?? null,
      gpsLatitude: gps.lat,
      gpsLongitude: gps.lon,
      gpsAltitude: real(effective, ID.gpsAltitude) ?? null,
      gpsAltitudeRef: real(effective, ID.gpsAltitudeRef) ?? null,
      locationXmp: scalar(effective, ID.xmpLocation) ?? null,
      locationIptc: scalar(effective, ID.iptcSubLocation) ?? null,
      cityXmp: scalar(effective, ID.xmpCity) ?? null,
      cityIptc: scalar(effective, ID.iptcCity) ?? null,
      stateXmp: scalar(effective, ID.xmpState) ?? null,
      stateIptc: scalar(effective, ID.iptcProvinceState) ?? null,
      countryXmp: scalar(effective, ID.xmpCountry) ?? null,
      countryIptc: scalar(effective, ID.iptcCountryName) ?? null,
      countryCodeXmp: scalar(effective, ID.xmpCountryCode) ?? null,
      countryCodeIptc: scalar(effective, ID.iptcCountryCode) ?? null,
    };
  }

  if (groupSet.has("description")) {
    groupInputs.description = {
      description: scalar(effective, ID.xmpDescription) ?? null,
      imageDescription: scalar(effective, ID.imageDescription) ?? null,
      captionAbstract: scalar(effective, ID.iptcCaption) ?? null,
      iptcCharsetIsUtf8:
        scalar(effective, ID.iptcCodedCharacterSet) === "UTF8" ||
        scalar(effective, ID.iptcCodedCharacterSet) === "\u001b%G",
      aiDescription: scalar(effective, ID.mlibAiDescription) ?? null,
      aiInterpretation: scalar(effective, ID.mlibAiInterpretation) ?? null,
      aiOcrText: list(effective, ID.mlibAiOcrText),
      aiObjects: list(effective, ID.mlibAiObjects),
      locationContext: null,
      keywordsContext: [],
      dateContext: null,
    };
  }

  if (groupSet.has("iptc_utf8")) {
    groupInputs.iptcUtf8 = {
      hasIptc: metadataEntries(effective).some(({ id }) =>
        id.table.startsWith("IPTC::"),
      ),
      codedCharacterSet: scalar(effective, ID.iptcCodedCharacterSet) ?? null,
    };
  }

  if (groupSet.has("dates")) {
    groupInputs.dates = {
      dateTimeOriginal: scalarValue(effective, ID.dateTimeOriginal) ?? null,
      offsetTimeOriginal: scalarValue(effective, ID.offsetTimeOriginal) ?? null,
      subSecTimeOriginal: scalarValue(effective, ID.subSecTimeOriginal) ?? null,
      photoshopDateCreated: scalarValue(effective, ID.xmpDateCreated) ?? null,
      iptcDateCreated: scalarValue(effective, ID.iptcDateCreated) ?? null,
      iptcTimeCreated: scalarValue(effective, ID.iptcTimeCreated) ?? null,
      createDate: scalarValue(effective, ID.createDate) ?? null,
      offsetTimeDigitized:
        scalarValue(effective, ID.offsetTimeDigitized) ?? null,
      offsetTime: scalarValue(effective, ID.offsetTime) ?? null,
      subSecTimeDigitized:
        scalarValue(effective, ID.subSecTimeDigitized) ?? null,
      xmpCreateDate: scalarValue(effective, ID.xmpCreateDate) ?? null,
      iptcDigitalCreationDate:
        scalarValue(effective, ID.iptcDigitalCreationDate) ?? null,
      iptcDigitalCreationTime:
        scalarValue(effective, ID.iptcDigitalCreationTime) ?? null,
      fileStem: fileStemOf(relPath),
    };
  }

  return { relPath, groupInputs };
}

export function buildNormaliseItems(
  relPaths: ReadonlyArray<string>,
  occurrences: FileOccurrencesLookup,
  targetDrafts: TargetDraftEditsByFile,
  enabledGroups: ReadonlyArray<NormaliseGroup>,
): NormaliseRequestItem[] {
  return relPaths.map((relPath) =>
    buildNormaliseItemForFile(
      relPath,
      enabledGroups,
      occurrences.get(relPath),
      targetDrafts[relPath],
    ),
  );
}

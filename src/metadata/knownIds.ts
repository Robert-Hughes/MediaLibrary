import type { MetadataWriteTarget, SchemaDefinitionId } from "../types";
import { family7GroupFromSchemaId } from "../utils/metadataWriteTarget";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";

const id = (
  table: string,
  tag_id: string,
  index?: number,
): SchemaDefinitionId => ({
  table,
  tag_id,
  ...(index === undefined ? {} : { index }),
});

export const KNOWN_METADATA_IDS = {
  imageDescription: id("Exif::Main", "270"),
  artist: id("Exif::Main", "315"),
  copyright: id("Exif::Main", "33432"),
  exposureTime: id("Exif::Main", "33434"),
  fNumber: id("Exif::Main", "33437"),
  focalLength: id("Exif::Main", "37386"),
  flash: id("Exif::Main", "37385"),
  dateTimeOriginal: id("Exif::Main", "36867"),
  createDate: id("Exif::Main", "36868"),
  gpsLatitudeRef: id("GPS::Main", "1"),
  gpsLatitude: id("GPS::Main", "2"),
  gpsLongitudeRef: id("GPS::Main", "3"),
  gpsLongitude: id("GPS::Main", "4"),
  gpsAltitudeRef: id("GPS::Main", "5"),
  gpsAltitude: id("GPS::Main", "6"),
  iptcObjectName: id("IPTC::ApplicationRecord", "5"),
  iptcKeywords: id("IPTC::ApplicationRecord", "25"),
  iptcDateCreated: id("IPTC::ApplicationRecord", "55"),
  iptcTimeCreated: id("IPTC::ApplicationRecord", "60"),
  iptcDigitalCreationDate: id("IPTC::ApplicationRecord", "62"),
  iptcDigitalCreationTime: id("IPTC::ApplicationRecord", "63"),
  iptcByLine: id("IPTC::ApplicationRecord", "80"),
  iptcCity: id("IPTC::ApplicationRecord", "90"),
  iptcSubLocation: id("IPTC::ApplicationRecord", "92"),
  iptcProvinceState: id("IPTC::ApplicationRecord", "95"),
  iptcCountryCode: id("IPTC::ApplicationRecord", "100"),
  iptcCountryName: id("IPTC::ApplicationRecord", "101"),
  iptcHeadline: id("IPTC::ApplicationRecord", "105"),
  iptcCopyright: id("IPTC::ApplicationRecord", "116"),
  iptcCaption: id("IPTC::ApplicationRecord", "120"),
  xmpDescription: id("XMP::dc", "description"),
  xmpTitle: id("XMP::dc", "title"),
  xmpSubject: id("XMP::dc", "subject"),
  xmpCreator: id("XMP::dc", "creator"),
  xmpRights: id("XMP::dc", "rights"),
  xmpHierarchicalSubject: id("XMP::Lightroom", "hierarchicalSubject"),
  xmpHeadline: id("XMP::photoshop", "Headline"),
  xmpCity: id("XMP::photoshop", "City"),
  xmpState: id("XMP::photoshop", "State"),
  xmpCountry: id("XMP::photoshop", "Country"),
  xmpDateCreated: id("XMP::photoshop", "DateCreated"),
  xmpLocation: id("XMP::iptcCore", "Location"),
  xmpCountryCode: id("XMP::iptcCore", "CountryCode"),
  xmpExifDateTimeOriginal: id("XMP::exif", "DateTimeOriginal"),
  xmpCreateDate: id("XMP::xmp", "CreateDate"),
  mlibAiDescription: id("UserDefined::mlib", "AIDescription"),
  mlibAiInterpretation: id("UserDefined::mlib", "AIInterpretation"),
  mlibAiObjects: id("UserDefined::mlib", "AIObjects"),
  mlibAiOcrText: id("UserDefined::mlib", "AIOcrText"),
  mlibAiTags: id("UserDefined::mlib", "AITags"),
  mlibAiModel: id("UserDefined::mlib", "AIModel"),
  mlibAiPromptVersion: id("UserDefined::mlib", "AIPromptVersion"),
  mlibAiGeneratedAt: id("UserDefined::mlib", "AIGeneratedAt"),
  offsetTime: id("Exif::Main", "36880"),
  offsetTimeOriginal: id("Exif::Main", "36881"),
  offsetTimeDigitized: id("Exif::Main", "36882"),
  subSecTimeOriginal: id("Exif::Main", "37521"),
  subSecTimeDigitized: id("Exif::Main", "37522"),
  iptcCodedCharacterSet: id("IPTC::EnvelopeRecord", "90"),
} as const;

export const GPS_IDS = {
  latitude: KNOWN_METADATA_IDS.gpsLatitude,
  latitudeRef: KNOWN_METADATA_IDS.gpsLatitudeRef,
  longitude: KNOWN_METADATA_IDS.gpsLongitude,
  longitudeRef: KNOWN_METADATA_IDS.gpsLongitudeRef,
  altitude: KNOWN_METADATA_IDS.gpsAltitude,
  altitudeRef: KNOWN_METADATA_IDS.gpsAltitudeRef,
} as const;

export function isKnownId(
  candidate: SchemaDefinitionId,
  expected: SchemaDefinitionId,
): boolean {
  return schemaDefinitionIdEquals(candidate, expected);
}

export function knownToken(value: SchemaDefinitionId): string {
  return schemaDefinitionIdToken(value);
}

const WRITE_DEFINITIONS: Array<
  readonly [SchemaDefinitionId, group1: string, tagName: string]
> = [
  [KNOWN_METADATA_IDS.imageDescription, "IFD0", "ImageDescription"],
  [KNOWN_METADATA_IDS.artist, "IFD0", "Artist"],
  [KNOWN_METADATA_IDS.copyright, "IFD0", "Copyright"],
  [KNOWN_METADATA_IDS.dateTimeOriginal, "ExifIFD", "DateTimeOriginal"],
  [KNOWN_METADATA_IDS.createDate, "ExifIFD", "CreateDate"],
  [KNOWN_METADATA_IDS.gpsLatitudeRef, "GPS", "GPSLatitudeRef"],
  [KNOWN_METADATA_IDS.gpsLatitude, "GPS", "GPSLatitude"],
  [KNOWN_METADATA_IDS.gpsLongitudeRef, "GPS", "GPSLongitudeRef"],
  [KNOWN_METADATA_IDS.gpsLongitude, "GPS", "GPSLongitude"],
  [KNOWN_METADATA_IDS.gpsAltitudeRef, "GPS", "GPSAltitudeRef"],
  [KNOWN_METADATA_IDS.gpsAltitude, "GPS", "GPSAltitude"],
  [KNOWN_METADATA_IDS.iptcObjectName, "IPTC", "ObjectName"],
  [KNOWN_METADATA_IDS.iptcKeywords, "IPTC", "Keywords"],
  [KNOWN_METADATA_IDS.iptcDateCreated, "IPTC", "DateCreated"],
  [KNOWN_METADATA_IDS.iptcTimeCreated, "IPTC", "TimeCreated"],
  [KNOWN_METADATA_IDS.iptcDigitalCreationDate, "IPTC", "DigitalCreationDate"],
  [KNOWN_METADATA_IDS.iptcDigitalCreationTime, "IPTC", "DigitalCreationTime"],
  [KNOWN_METADATA_IDS.iptcByLine, "IPTC", "By-line"],
  [KNOWN_METADATA_IDS.iptcCity, "IPTC", "City"],
  [KNOWN_METADATA_IDS.iptcSubLocation, "IPTC", "Sub-location"],
  [KNOWN_METADATA_IDS.iptcProvinceState, "IPTC", "Province-State"],
  [KNOWN_METADATA_IDS.iptcCountryCode, "IPTC", "Country-PrimaryLocationCode"],
  [KNOWN_METADATA_IDS.iptcCountryName, "IPTC", "Country-PrimaryLocationName"],
  [KNOWN_METADATA_IDS.iptcHeadline, "IPTC", "Headline"],
  [KNOWN_METADATA_IDS.iptcCopyright, "IPTC", "CopyrightNotice"],
  [KNOWN_METADATA_IDS.iptcCaption, "IPTC", "Caption-Abstract"],
  [KNOWN_METADATA_IDS.xmpDescription, "XMP-dc", "Description"],
  [KNOWN_METADATA_IDS.xmpTitle, "XMP-dc", "Title"],
  [KNOWN_METADATA_IDS.xmpSubject, "XMP-dc", "Subject"],
  [KNOWN_METADATA_IDS.xmpCreator, "XMP-dc", "Creator"],
  [KNOWN_METADATA_IDS.xmpRights, "XMP-dc", "Rights"],
  [KNOWN_METADATA_IDS.xmpHierarchicalSubject, "XMP-lr", "HierarchicalSubject"],
  [KNOWN_METADATA_IDS.xmpHeadline, "XMP-photoshop", "Headline"],
  [KNOWN_METADATA_IDS.xmpCity, "XMP-photoshop", "City"],
  [KNOWN_METADATA_IDS.xmpState, "XMP-photoshop", "State"],
  [KNOWN_METADATA_IDS.xmpCountry, "XMP-photoshop", "Country"],
  [KNOWN_METADATA_IDS.xmpDateCreated, "XMP-photoshop", "DateCreated"],
  [KNOWN_METADATA_IDS.xmpLocation, "XMP-iptcCore", "Location"],
  [KNOWN_METADATA_IDS.xmpCountryCode, "XMP-iptcCore", "CountryCode"],
  [KNOWN_METADATA_IDS.xmpCreateDate, "XMP-xmp", "CreateDate"],
  [KNOWN_METADATA_IDS.mlibAiDescription, "XMP-mlib", "AIDescription"],
  [KNOWN_METADATA_IDS.mlibAiInterpretation, "XMP-mlib", "AIInterpretation"],
  [KNOWN_METADATA_IDS.mlibAiObjects, "XMP-mlib", "AIObjects"],
  [KNOWN_METADATA_IDS.mlibAiOcrText, "XMP-mlib", "AIOcrText"],
  [KNOWN_METADATA_IDS.mlibAiTags, "XMP-mlib", "AITags"],
  [KNOWN_METADATA_IDS.mlibAiModel, "XMP-mlib", "AIModel"],
  [KNOWN_METADATA_IDS.mlibAiPromptVersion, "XMP-mlib", "AIPromptVersion"],
  [KNOWN_METADATA_IDS.mlibAiGeneratedAt, "XMP-mlib", "AIGeneratedAt"],
];

const WRITE_NAMES = new Map<string, readonly [group1: string, tagName: string]>(
  WRITE_DEFINITIONS.map(([schemaId, group1, tagName]) => [
    schemaDefinitionIdToken(schemaId),
    [group1, tagName] as const,
  ]),
);

/** Default destinations for the closed set used by generated/GPS workflows. */
export function knownMetadataWriteTarget(
  schemaId: SchemaDefinitionId,
): MetadataWriteTarget | null {
  const names = WRITE_NAMES.get(schemaDefinitionIdToken(schemaId));
  return names
    ? {
        group1: names[0],
        group7: family7GroupFromSchemaId(schemaId),
        tag_name: names[1],
      }
    : null;
}

import type { SchemaDefinitionId } from "../types";
import { GPS_IDS, KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const known: Record<string, SchemaDefinitionId> = {
  "IFD0:ImageDescription": ID.imageDescription,
  "IFD0:Artist": ID.artist,
  "IFD0:Copyright": ID.copyright,
  "ExifIFD:ExposureTime": ID.exposureTime,
  "EXIF:ExposureTime": ID.exposureTime,
  "ExifIFD:FNumber": ID.fNumber,
  "ExifIFD:FocalLength": ID.focalLength,
  "EXIF:Flash": ID.flash,
  "ExifIFD:Flash": ID.flash,
  "ExifIFD:DateTimeOriginal": ID.dateTimeOriginal,
  "ExifIFD:CreateDate": ID.createDate,
  "ExifIFD:OffsetTime": ID.offsetTime,
  "ExifIFD:OffsetTimeOriginal": ID.offsetTimeOriginal,
  "ExifIFD:OffsetTimeDigitized": ID.offsetTimeDigitized,
  "ExifIFD:SubSecTimeOriginal": ID.subSecTimeOriginal,
  "ExifIFD:SubSecTimeDigitized": ID.subSecTimeDigitized,
  "GPS:GPSLatitude": GPS_IDS.latitude,
  "GPS:GPSLatitudeRef": GPS_IDS.latitudeRef,
  "GPS:GPSLongitude": GPS_IDS.longitude,
  "GPS:GPSLongitudeRef": GPS_IDS.longitudeRef,
  "GPS:GPSAltitude": GPS_IDS.altitude,
  "GPS:GPSAltitudeRef": GPS_IDS.altitudeRef,
  "XMP-dc:Description": ID.xmpDescription,
  "XMP-dc:Title": ID.xmpTitle,
  "XMP-dc:Subject": ID.xmpSubject,
  "XMP-dc:Creator": ID.xmpCreator,
  "XMP-dc:Rights": ID.xmpRights,
  "XMP-lr:HierarchicalSubject": ID.xmpHierarchicalSubject,
  "XMP-photoshop:Headline": ID.xmpHeadline,
  "XMP-photoshop:City": ID.xmpCity,
  "XMP-photoshop:State": ID.xmpState,
  "XMP-photoshop:Country": ID.xmpCountry,
  "XMP-photoshop:DateCreated": ID.xmpDateCreated,
  "XMP-iptcCore:Location": ID.xmpLocation,
  "XMP-iptcCore:CountryCode": ID.xmpCountryCode,
  "XMP-iptcExt:LocationCreated": ID.xmpLocationCreated,
  "XMP-exif:DateTimeOriginal": ID.xmpExifDateTimeOriginal,
  "XMP-xmp:CreateDate": ID.xmpCreateDate,
  "XMP-mlib:AIDescription": ID.mlibAiDescription,
  "XMP-mlib:AIInterpretation": ID.mlibAiInterpretation,
  "XMP-mlib:AIObjects": ID.mlibAiObjects,
  "XMP-mlib:AIOcrText": ID.mlibAiOcrText,
  "XMP-mlib:AITags": ID.mlibAiTags,
  "XMP-mlib:ReverseGeocodeGeocodeJSON": ID.mlibReverseGeocodeGeocodeJson,
  "XMP-mlib:ReverseGeocodeJSONv2": ID.mlibReverseGeocodeJsonV2,
  "IPTC:ObjectName": ID.iptcObjectName,
  "IPTC:Keywords": ID.iptcKeywords,
  "IPTC:DateCreated": ID.iptcDateCreated,
  "IPTC:TimeCreated": ID.iptcTimeCreated,
  "IPTC:DigitalCreationDate": ID.iptcDigitalCreationDate,
  "IPTC:DigitalCreationTime": ID.iptcDigitalCreationTime,
  "IPTC:By-line": ID.iptcByLine,
  "IPTC:City": ID.iptcCity,
  "IPTC:Sub-location": ID.iptcSubLocation,
  "IPTC:Province-State": ID.iptcProvinceState,
  "IPTC:Country-PrimaryLocationCode": ID.iptcCountryCode,
  "IPTC:Country-PrimaryLocationName": ID.iptcCountryName,
  "IPTC:Headline": ID.iptcHeadline,
  "IPTC:CopyrightNotice": ID.iptcCopyright,
  "IPTC:Caption-Abstract": ID.iptcCaption,
};

/**
 * Canonical labels are the first label declared above for an exact ID. Aliases
 * remain valid fixture input, but reverse lookup always returns the canonical
 * label so callback assertions are deterministic.
 */
const canonicalNames = new Map<string, string>();
for (const [name, id] of Object.entries(known)) {
  const token = schemaDefinitionIdToken(id);
  if (!canonicalNames.has(token)) canonicalNames.set(token, name);
}

export function testId(name: string): SchemaDefinitionId {
  return known[name] ?? { table: "Test::Fixture", tag_id: name };
}

export function testFriendlyName(id: SchemaDefinitionId): string {
  return canonicalNames.get(schemaDefinitionIdToken(id)) ?? id.tag_id;
}

export const testIdForFriendlyName = testId;

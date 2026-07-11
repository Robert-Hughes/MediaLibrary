import type { SchemaDefinitionId } from "../types";
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
  offsetTime: id("Exif::Main", "36880"),
  offsetTimeOriginal: id("Exif::Main", "36881"),
  offsetTimeDigitized: id("Exif::Main", "36882"),
  subSecTimeOriginal: id("Exif::Main", "37521"),
  subSecTimeDigitized: id("Exif::Main", "37522"),
  iptcCodedCharacterSet: id("IPTC::EnvelopeRecord", "90"),
  compositeGpsLatitude: id("Composite", "GPS-GPSLatitude"),
  compositeGpsLongitude: id("Composite", "GPS-GPSLongitude"),
  compositeShutterSpeed: id("Composite", "Exif-ShutterSpeed"),
  compositeAperture: id("Composite", "Exif-Aperture"),
  compositeFocalLength35efl: id("Composite", "Exif-FocalLength35efl"),
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

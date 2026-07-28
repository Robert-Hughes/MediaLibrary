import { describe, expect, it } from "vitest";
import {
  KNOWN_METADATA_IDS as ID,
  knownMetadataWriteTarget,
} from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataOccurrence,
  MetadataValue,
  NormaliseGroup,
  SchemaDefinitionId,
} from "../types";
import {
  buildNormaliseItemForFile,
  buildNormaliseItems,
} from "../utils/buildNormaliseItems";
import { mockMetadata } from "./factories";
import {
  occurrenceFromSchemaValue,
  occurrencesFromMetadataCollection,
} from "./occurrenceFixtures";

const ALL_GROUPS: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "iptc_utf8",
  "headline",
  "title",
  "location",
  "dates",
];

function atDeclaredDestinations(
  occurrences: MetadataOccurrence[],
): MetadataOccurrence[] {
  return occurrences.map((occurrence) => {
    const destination = knownMetadataWriteTarget(occurrence.schema_id);
    return destination === null
      ? occurrence
      : {
          ...occurrence,
          observed_selector: structuredClone(destination),
          write_target: structuredClone(destination),
        };
  });
}

function destinationOccurrence(
  id: SchemaDefinitionId,
  value: MetadataValue,
  group1: string,
  ordinal: number,
): MetadataOccurrence {
  const occurrence = occurrenceFromSchemaValue(id, value, ordinal);
  const declared = knownMetadataWriteTarget(id);
  if (declared === null) throw new Error("Expected declared destination");
  const selector = { ...declared, group1 };
  return {
    ...occurrence,
    id: {
      ...occurrence.id,
      path: `JPEG-APP1-${group1}`,
      copy: ordinal,
    },
    observed_selector: selector,
    write_target: structuredClone(selector),
  };
}

describe("target-aware normalise inputs", () => {
  it("packs semantic metadata without flattening LangAlt or list values", () => {
    const occurrences = atDeclaredDestinations(
      occurrencesFromMetadataCollection(
        mockMetadata({
          "XMP-dc:Subject": ["one", "two"],
          "XMP-dc:Description": {
            kind: "LangAlt",
            value: { "x-default": "Caption", fr: "Légende" },
          },
        }),
      ),
    );
    const item = buildNormaliseItemForFile(
      "x.jpg",
      ["keywords", "description"],
      occurrences,
    );
    expect(item.groupInputs.keywords?.dcSubject).toEqual(["one", "two"]);
    expect(item.groupInputs.description?.description).toBe("Caption");
  });

  it("uses a complete NewProperty target draft in the effective view", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      "a.jpg",
      {
        kind: "NewProperty",
        schema_id: ID.xmpTitle,
        write_target: knownMetadataWriteTarget(ID.xmpTitle)!,
      },
      { intent: "Set", value: { kind: "Text", value: "from-target" } },
    );
    const items = buildNormaliseItems(
      ["a.jpg"],
      { get: () => [] },
      store.getAllMetadata(),
      ["title"],
    );
    expect(items[0].groupInputs.title?.title).toBe("from-target");
  });

  it("passes raw geocode evidence and camera coordinates to Location", () => {
    const occurrences = atDeclaredDestinations(
      occurrencesFromMetadataCollection(
        mockMetadata({
          "XMP-mlib:ReverseGeocodeGeocodeJSON": '{"features":[]}',
          "XMP-mlib:ReverseGeocodeJSONv2": '{"display_name":"Ely"}',
          "GPS:GPSLatitude": { kind: "Real", value: 52.4 },
          "GPS:GPSLongitude": { kind: "Real", value: 0.26 },
          "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
          "GPS:GPSLongitudeRef": { kind: "Text", value: "W" },
          "GPS:GPSAltitude": { kind: "Real", value: 12.5 },
          "GPS:GPSAltitudeRef": { kind: "Integer", value: 0 },
        }),
      ),
    );
    const item = buildNormaliseItemForFile(
      "ely.jpg",
      ["location"],
      occurrences,
    );
    expect(item.groupInputs.location).toMatchObject({
      geocodeJson: '{"features":[]}',
      jsonV2: '{"display_name":"Ely"}',
      gpsLatitude: 52.4,
      gpsLongitude: -0.26,
      gpsAltitude: 12.5,
      gpsAltitudeRef: 0,
    });
  });

  it("keeps missing groups populated with neutral values", () => {
    const items = buildNormaliseItems(
      ["unknown.jpg"],
      { get: () => [] },
      {},
      ALL_GROUPS,
    );
    expect(items[0].groupInputs.keywords?.dcSubject).toEqual([]);
    expect(items[0].groupInputs.creator?.creator).toEqual([]);
    expect(items[0].groupInputs.dates?.fileStem).toBe("unknown");
    expect(items[0].groupInputs.iptcUtf8).toEqual({
      hasIptc: false,
      codedCharacterSet: null,
    });
  });

  it("builds IPTC UTF-8 input from the effective metadata view", () => {
    const occurrences = atDeclaredDestinations([
      occurrenceFromSchemaValue(ID.iptcCodedCharacterSet, {
        kind: "Text",
        value: "Latin",
      }),
    ]);
    const item = buildNormaliseItemForFile(
      "legacy.jpg",
      ["iptc_utf8"],
      occurrences,
    );

    expect(item.groupInputs.iptcUtf8).toEqual({
      hasIptc: true,
      codedCharacterSet: "Latin",
    });
  });

  it("keeps arbitrary IPTC schemas in the restricted effective view", () => {
    const occurrence = occurrenceFromSchemaValue(ID.iptcCodedCharacterSet, {
      kind: "Text",
      value: "custom IPTC value",
    });
    const customId: SchemaDefinitionId = {
      table: "IPTC::CustomRecord",
      tag_id: "201",
    };
    occurrence.schema_id = customId;
    occurrence.tag_info = occurrence.tag_info
      ? { ...occurrence.tag_info, id: customId }
      : null;
    occurrence.observed_selector = null;
    occurrence.write_target = null;

    const item = buildNormaliseItemForFile(
      "custom-iptc.jpg",
      ["iptc_utf8"],
      [occurrence],
    );

    expect(item.groupInputs.iptcUtf8).toEqual({
      hasIptc: true,
      codedCharacterSet: null,
    });
  });

  it("reads only the declared IFD0 ImageDescription destination", () => {
    const occurrences = [
      destinationOccurrence(
        ID.imageDescription,
        { kind: "Text", value: "primary" },
        "IFD0",
        0,
      ),
      destinationOccurrence(
        ID.imageDescription,
        { kind: "Text", value: "thumbnail" },
        "IFD1",
        1,
      ),
    ];

    const item = buildNormaliseItemForFile(
      "sony.jpg",
      ["description"],
      occurrences,
    );

    expect(item.groupInputs.description?.imageDescription).toBe("primary");
  });

  it("treats an IFD1-only ImageDescription as absent", () => {
    const item = buildNormaliseItemForFile(
      "thumbnail-only.jpg",
      ["description"],
      [
        destinationOccurrence(
          ID.imageDescription,
          { kind: "Text", value: "thumbnail" },
          "IFD1",
          1,
        ),
      ],
    );

    expect(item.groupInputs.description?.imageDescription).toBeNull();
  });
});

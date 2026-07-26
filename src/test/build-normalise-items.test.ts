import { describe, expect, it } from "vitest";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type { NormaliseGroup } from "../types";
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

describe("target-aware normalise inputs", () => {
  it("packs semantic metadata without flattening LangAlt or list values", () => {
    const occurrences = occurrencesFromMetadataCollection(
      mockMetadata({
        "XMP-dc:Subject": ["one", "two"],
        "XMP-dc:Description": {
          kind: "LangAlt",
          value: { "x-default": "Caption", fr: "Légende" },
        },
      }),
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
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
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
    const occurrences = occurrencesFromMetadataCollection(
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
    const occurrences = [
      occurrenceFromSchemaValue(ID.iptcCodedCharacterSet, {
        kind: "Text",
        value: "Latin",
      }),
    ];
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
});

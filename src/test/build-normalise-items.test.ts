import { describe, expect, it } from "vitest";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type { NormaliseGroup } from "../types";
import {
  buildNormaliseItemForPhoto,
  buildNormaliseItems,
} from "../utils/buildNormaliseItems";
import { mockMetadata } from "./factories";
import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";

const ALL_GROUPS: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
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
    const item = buildNormaliseItemForPhoto(
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
      { kind: "NewProperty", schema_id: ID.xmpTitle },
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
  });
});

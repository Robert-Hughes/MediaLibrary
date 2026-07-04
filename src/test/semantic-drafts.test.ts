import { describe, expect, it } from "vitest";
import type { DraftEditsByFile, MetadataDraftEdit } from "../types";
import {
  legacyDraftsToMetadataDrafts,
  metadataDraftsToLegacyDrafts,
  metadataEntryToVariant,
  normalizeGeneratedDraftEdits,
} from "../utils/semanticDrafts";

describe("semantic draft adapters", () => {
  it("converts legacy draft variants to semantic v3 draft values", () => {
    const drafts: DraftEditsByFile = {
      "a.jpg": {
        "XMP-dc:Subject": {
          value: ["one", "two"],
          intent: "Set",
          display: "one, two",
        },
      },
    };

    expect(legacyDraftsToMetadataDrafts(drafts)).toEqual({
      "a.jpg": {
        "XMP-dc:Subject": {
          value: {
            kind: "List",
            value: {
              list_kind: "Unknown",
              items: [
                { kind: "Text", value: "one" },
                { kind: "Text", value: "two" },
              ],
            },
          },
          intent: "Set",
          display: "one, two",
        },
      },
    });
  });

  it("converts semantic v3 draft values back to the current editor shape", () => {
    const edit: MetadataDraftEdit = {
      value: {
        kind: "Date",
        value: { year: 2026, month: 7, day: 4 },
      },
      intent: "Set",
    };

    expect(
      metadataDraftsToLegacyDrafts({ "a.jpg": { "IPTC:DateCreated": edit } }),
    ).toEqual({
      "a.jpg": {
        "IPTC:DateCreated": {
          value: "2026:07:04",
          intent: "Set",
          display: "2026:07:04",
        },
      },
    });
  });

  it("does not turn Unknown semantic values into editable text", () => {
    expect(
      metadataEntryToVariant({
        kind: "Unknown",
        value: {
          expected: null,
          raw: "raw-value",
          reason: "no schema entry for tag",
        },
      }),
    ).toBeNull();
  });

  it("normalizes semantic generated batch edits for the current draft store", () => {
    expect(
      normalizeGeneratedDraftEdits({
        "IPTC:TimeCreated": {
          value: {
            kind: "Time",
            value: {
              hour: 10,
              minute: 56,
              second: 5,
              subsecond: null,
              offset: null,
            },
          },
          intent: "Set",
        },
      }),
    ).toEqual({
      "IPTC:TimeCreated": {
        value: "10:56:05",
        intent: "Set",
        display: "10:56:05",
      },
    });
  });

  it("normalizes older wrapped variant batch edits from tests and mocks", () => {
    expect(
      normalizeGeneratedDraftEdits({
        "XMP-mlib:AIDescription": {
          value: { type: "String", value: "a calm beach scene" },
          intent: "Set",
        },
        "XMP-mlib:AITags": {
          value: {
            type: "List",
            value: [{ type: "String", value: "beach" }],
          },
          intent: "Set",
        },
      }),
    ).toEqual({
      "XMP-mlib:AIDescription": {
        value: "a calm beach scene",
        intent: "Set",
        display: undefined,
      },
      "XMP-mlib:AITags": {
        value: ["beach"],
        intent: "Set",
        display: undefined,
      },
    });
  });
});

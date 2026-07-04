import { describe, expect, it } from "vitest";
import type { DraftEditsByFile, MetadataDraftEdit } from "../types";
import {
  legacyDraftsToMetadataDrafts,
  metadataDraftsToLegacyDrafts,
  metadataEntryToVariant,
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
});

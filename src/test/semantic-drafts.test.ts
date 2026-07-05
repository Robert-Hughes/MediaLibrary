import { describe, expect, it } from "vitest";
import type { MetadataDraftEdit } from "../types";
import {
  legacyDraftToMetadataDraft,
  metadataDraftToLegacyDraft,
} from "../utils/semanticDrafts";

describe("semantic draft adapters", () => {
  it("converts legacy draft variants to semantic draft values", () => {
    expect(
      legacyDraftToMetadataDraft({
        value: ["one", "two"],
        intent: "Set",
        display: "one, two",
      }),
    ).toEqual({
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
    });
  });

  it("converts semantic draft values back to the current editor shape", () => {
    const edit: MetadataDraftEdit = {
      value: {
        kind: "Date",
        value: { year: 2026, month: 7, day: 4 },
      },
      intent: "Set",
    };

    expect(metadataDraftToLegacyDraft(edit)).toEqual({
      value: "2026:07:04",
      intent: "Set",
      display: "2026:07:04",
    });
  });
});

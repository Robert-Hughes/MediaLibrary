import { describe, expect, it } from "vitest";
import type { MetadataDraftEdit } from "../types";
import { metadataDraftToLegacyDraft } from "../utils/semanticDrafts";

describe("semantic draft adapters", () => {
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

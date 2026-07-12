import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { MetadataDraftEdit } from "../types";
import { _clearTagInfoCache, useTagInfo } from "../hooks/useTagInfo";
import { mockDrafts, mockMetadata, testId } from "./factories";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

beforeEach(() => {
  _clearTagInfoCache();
});

describe("exact-ID test factories", () => {
  it("preserves every draft edit intent and optional display text", () => {
    const edits = {
      "Test:Set": {
        intent: "Set",
        value: { kind: "Text", value: "replacement" },
        display: "Replacement",
      },
      "Test:Delete": { intent: "Delete", value: null },
      "Test:ListAdd": {
        intent: "ListAdd",
        value: {
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [{ kind: "Text", value: "added" }],
          },
        },
        display: "Added",
      },
      "Test:ListRemove": {
        intent: "ListRemove",
        value: {
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [{ kind: "Text", value: "removed" }],
          },
        },
      },
    } satisfies Record<string, MetadataDraftEdit>;

    const drafts = mockDrafts(edits);

    for (const [name, edit] of Object.entries(edits)) {
      expect(drafts[schemaDefinitionIdToken(testId(name))].edit).toEqual(edit);
    }
  });

  it("uses the canonical label for aliases regardless of fixture ordering", () => {
    const canonical = "ExifIFD:ExposureTime";
    const alias = "EXIF:ExposureTime";
    const id = testId(canonical);
    expect(testId(alias)).toEqual(id);

    const labelAfter = (names: string[]) => {
      _clearTagInfoCache();
      mockMetadata(Object.fromEntries(names.map((name) => [name, "1/125"])));
      const { result } = renderHook(() => useTagInfo(id));
      expect(result.current).not.toBe("loading");
      expect(result.current).not.toBeNull();
      return result.current && result.current !== "loading"
        ? `${result.current.group}:${result.current.name}`
        : null;
    };

    expect(labelAfter([alias, canonical])).toBe(canonical);
    expect(labelAfter([canonical, alias])).toBe(canonical);
  });

  it("retains supplied labels for synthetic fixture IDs", () => {
    const label = "Synthetic:HumanLabel";
    const id = testId(label);
    mockMetadata({ [label]: "value" });

    const { result } = renderHook(() => useTagInfo(id));
    expect(result.current).toMatchObject({
      id,
      group: "Synthetic",
      name: "HumanLabel",
    });
  });
});

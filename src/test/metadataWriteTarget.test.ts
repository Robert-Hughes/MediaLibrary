import { describe, expect, it } from "vitest";
import {
  family7GroupFromRuntimeTagId,
  family7GroupFromSchemaId,
  metadataWriteSelector,
  metadataWriteTargetEquals,
  metadataWriteTargetToken,
  validateFamily1Group,
} from "../utils/metadataWriteTarget";

describe("metadata write targets", () => {
  it("preserves all three selector components in equality, tokens, and rendering", () => {
    const target = {
      group1: "ItemList",
      group7: "ID-a9nam",
      tag_name: "Title",
    };
    expect(metadataWriteSelector(target)).toBe("1ItemList:7ID-a9nam:Title");
    expect(metadataWriteTargetToken(target)).toBe(
      JSON.stringify(["ItemList", "ID-a9nam", "Title"]),
    );
    expect(metadataWriteTargetEquals(target, structuredClone(target))).toBe(
      true,
    );
    expect(
      metadataWriteTargetEquals(target, { ...target, group7: "ID-other" }),
    ).toBe(false);
  });

  it("derives family 7 from the correct identity without normalising nested ID text", () => {
    expect(family7GroupFromRuntimeTagId("282")).toBe("ID-282");
    expect(family7GroupFromRuntimeTagId("a9nam")).toBe("ID-a9nam");
    expect(family7GroupFromRuntimeTagId("ID-AbC")).toBe("ID-ID-AbC");
    expect(
      family7GroupFromSchemaId({
        table: "QuickTime::ItemList",
        tag_id: "a9nam",
      }),
    ).toBe("ID-a9nam");
    expect(
      family7GroupFromSchemaId({
        table: "QuickTime::ItemList",
        tag_id: "xid ",
      }),
    ).toBe("ID-xid20");
    expect(
      family7GroupFromSchemaId({
        table: "PDF::Info",
        tag_id: "AAPL:Keywords",
      }),
    ).toBe("ID-AAPL3aKeywords");
  });

  it("matches the backend family-1 token grammar", () => {
    for (const accepted of [
      "IFD0",
      "ItemList",
      "XMP-dc",
      "ICC_Profile#",
      "M-RAW",
    ]) {
      expect(validateFamily1Group(accepted), accepted).toBeNull();
    }
    for (const rejected of [
      "",
      " ",
      " IFD0",
      "IFD0 ",
      "IFD 0",
      "IFD0:EXIF",
      "IFD0=bad",
      "1IFD0",
      "IFD0\0",
      "IFD0\n",
      "IFD0\r",
      "-IFD0",
    ]) {
      expect(
        validateFamily1Group(rejected),
        JSON.stringify(rejected),
      ).not.toBeNull();
    }
  });
});

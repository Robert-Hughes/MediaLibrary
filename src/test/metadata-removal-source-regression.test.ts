import { describe, expect, it } from "vitest";
import source from "../metadataRemovalTargets.ts?raw";

describe("metadata removal identity source boundary", () => {
  it("does not compare a runtime occurrence tag ID with a schema tag ID", () => {
    expect(source).not.toMatch(
      /occurrence\s*\.\s*id\s*\.\s*tag_id\s*={2,3}\s*id\s*\.\s*tag_id/,
    );
    expect(source).not.toMatch(
      /id\s*\.\s*tag_id\s*={2,3}\s*occurrence\s*\.\s*id\s*\.\s*tag_id/,
    );
  });
});

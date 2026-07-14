import { describe, expect, it } from "vitest";
import source from "../components/DetailsPane.tsx?raw";

describe("Add Property production source boundary", () => {
  it("has no schema-v4 callback or DraftEditsStore write in stage two", () => {
    const stageTwo = source.slice(source.indexOf("{newPropertyKey !== null"));
    expect(stageTwo).toContain("onSetNewPropertyDraft");
    expect(stageTwo).not.toContain("onSetMetadataDraft?.(newPropertyKey");
    expect(stageTwo).not.toContain("DraftEditsStore");
  });
});

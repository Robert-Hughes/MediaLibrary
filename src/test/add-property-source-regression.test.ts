import { describe, expect, it } from "vitest";
import source from "../components/DetailsPane.tsx?raw";

describe("Add Property production source boundary", () => {
  it("stages new properties through the exact target callback", () => {
    const stageTwo = source.slice(source.indexOf("{newPropertyKey !== null"));
    expect(stageTwo).toContain("onSetNewPropertyDraft");
  });
});

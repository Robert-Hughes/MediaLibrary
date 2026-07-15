import { describe, expect, it } from "vitest";
import actions from "../useMediaLibrary.ts?raw";
import details from "../components/DetailsPane.tsx?raw";
import gallery from "../components/GalleryView.tsx?raw";
import app from "../App.tsx?raw";

describe("ordinary existing-row production boundary", () => {
  it("has no generic schema-v4 single-row producer or prop plumbing", () => {
    const existingAction = actions.slice(
      actions.indexOf("const setExistingOccurrenceDraft"),
      actions.indexOf("const setNewPropertyDraft"),
    );
    expect(existingAction).not.toContain(".setMetadataTag(");
    expect(existingAction).toContain(".setMetadataTarget(");
    expect(actions).not.toMatch(/\bsetMetadataDraft\b/);
    expect(details).not.toMatch(/\bonSetMetadataDraft\b/);
    expect(gallery).not.toMatch(/\bonSetMetadataDraft\b/);
    expect(app).not.toContain("actions.setMetadataDraft(");
  });

  it("keeps supplemental Edit and Remove on the exact v5 callback", () => {
    const supplementalRow = details.slice(
      details.indexOf("function DetailsOccurrenceRow"),
      details.indexOf("function DetailsRowContextMenu"),
    );
    const supplementalMenu = details.slice(
      details.indexOf("{supplementalContextMenu &&"),
      details.indexOf("{groupContextMenu &&"),
    );
    expect(supplementalRow).toContain("targetDraft?: MetadataDraftEntryV5");
    expect(supplementalMenu).toContain("onSetExistingOccurrenceDraft?.(");
    expect(supplementalMenu).not.toContain("onSetMetadataDraftBatch");
    expect(supplementalMenu).not.toContain("setMetadataTag(");
    expect(supplementalMenu).not.toContain("setMetadataDraftBatch(");
  });
});

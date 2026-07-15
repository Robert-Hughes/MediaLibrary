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
    expect(supplementalMenu).not.toContain("onRemoveMetadataFieldsV5");
    expect(supplementalMenu).not.toContain("setMetadataTag(");
    expect(supplementalMenu).not.toContain("setMetadataDraftBatch(");
  });

  it("keeps GPS row and composite editor saves off the schema-v4 callback", () => {
    const ordinaryRowMenu = details.slice(
      details.indexOf("{contextMenu &&"),
      details.indexOf("{supplementalContextMenu &&"),
    );
    const editor = details.slice(
      details.indexOf("{editDialog &&"),
      details.indexOf("{targetDraftsWritable && showNewPropertyDialog"),
    );
    expect(ordinaryRowMenu).toContain("onSetGpsTargetDraftBatch");
    expect(editor).toContain("onSetGpsTargetDraftBatch");
    expect(ordinaryRowMenu).not.toContain("onRemoveMetadataFieldsV5");
    expect(editor).not.toContain("onRemoveMetadataFieldsV5");
  });

  it("keeps manual group and selected-photo removal off every v4 producer", () => {
    const groupMenu = details.slice(
      details.indexOf("function DetailsGroupContextMenu"),
      details.indexOf("export function DetailsPane"),
    );
    const selectedField = app.slice(
      app.indexOf("onRemoveFieldFromSelectedPhotos="),
      app.indexOf("/>\n      {state.galleryIndex"),
    );
    for (const source of [groupMenu, selectedField]) {
      expect(source).not.toContain("onSetMetadataDraftBatch");
      expect(source).not.toContain("actions.setMetadataDraftBatch");
      expect(source).not.toContain("setMetadataTag(");
    }
    expect(groupMenu).toContain("onRemoveMetadataFieldsV5");
    expect(selectedField).toContain("actions.removeMetadataFieldFromFilesV5");
  });

  it("keeps every active generated workflow on the exact v5 boundary", () => {
    expect(app).toContain("actions.applyGeneratedMetadataDraftBatchV5(");
    expect(actions).toContain("const applyGeneratedMetadataDraftBatchV5");
    for (const source of [app, actions]) {
      expect(source).not.toContain("actions.setMetadataDraftBatch");
      expect(source).not.toContain("const setMetadataDraftBatch");
      expect(source).not.toContain(
        "draftEditsStoreRef.current.setMetadataBatch",
      );
    }
  });
});

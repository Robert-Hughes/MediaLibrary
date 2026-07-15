import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import actions from "../useMediaLibrary.ts?raw";
import batch from "../hooks/useBatchImageJob.ts?raw";
import describeHook from "../hooks/useDescribeImages.ts?raw";
import geocodeHook from "../hooks/useGeocodeImages.ts?raw";
import normaliseHook from "../hooks/useNormaliseMetadata.ts?raw";

describe("generated metadata production source boundary", () => {
  it("cannot create schema-v4 drafts from any active generated workflow", () => {
    const productionSources = [
      app,
      actions,
      batch,
      describeHook,
      geocodeHook,
      normaliseHook,
    ];
    for (const source of productionSources) {
      expect(source).not.toContain("actions.setMetadataDraftBatch");
      expect(source).not.toContain("const setMetadataDraftBatch");
      expect(source).not.toContain(
        "draftEditsStoreRef.current.setMetadataBatch",
      );
      expect(source).not.toContain("DraftEditsStore.setMetadataBatch");
      expect(source).not.toContain("DraftEditsStore.setMetadataTag");
    }
  });

  it("keeps producer identity explicit and stages through one v5 action", () => {
    expect(app).toContain('{ kind: "describe" }');
    expect(app).toContain('{ kind: "geocode" }');
    expect(app).toContain('kind: "normalise"');
    expect(app).toContain("actions.applyGeneratedMetadataDraftBatchV5(");
    expect(actions).toContain("planGeneratedTargetDraftBatchV5({");
    expect(actions).toContain("applyExactMutationBatch([");
    expect(batch).toContain('kind: "draft_stage_failed"');
  });

  it("captures the confirmed normalise groups rather than mutable checkbox state", () => {
    expect(normaliseHook).toContain("confirmedEnabledGroups");
    expect(normaliseHook).toContain(
      "structuredClone(stash.confirmedEnabledGroups)",
    );
    expect(normaliseHook).toContain(
      "stash.confirmedEnabledGroups = structuredClone(stash.enabledGroups)",
    );
  });
});

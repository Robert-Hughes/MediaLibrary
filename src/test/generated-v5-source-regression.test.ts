import { describe, expect, it } from "vitest";
import app from "../App.tsx?raw";
import actions from "../useMediaLibrary.ts?raw";
import batch from "../hooks/useBatchImageJob.ts?raw";
import normaliseHook from "../hooks/useNormaliseMetadata.ts?raw";

describe("generated metadata production source boundary", () => {
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

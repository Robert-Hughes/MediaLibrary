import { describe, expect, it } from "vitest";

const productionSources = import.meta.glob<string>("../*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const generatedSources = import.meta.glob<string>("../types/generated/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const useMediaLibrary = productionSources["../useMediaLibrary.ts"];

describe("Rust-authoritative application boundary", () => {
  it("does not retain the removed frontend draft autosave authority", () => {
    expect(productionSources).not.toHaveProperty(
      "../targetDraftAutosaveGate.ts",
    );
    expect(useMediaLibrary).toBeDefined();
    expect(useMediaLibrary).not.toContain("targetDraftAutosaveGate");
    expect(useMediaLibrary).not.toContain("setMetadataDraftBatch");
    expect(useMediaLibrary).not.toContain("mergeBatchEdits");
  });

  it("projects verification outcomes from Rust snapshots without local reconciliation", () => {
    expect(useMediaLibrary).toBeDefined();
    expect(useMediaLibrary).toContain("snapshot.verification_outcomes");
    expect(useMediaLibrary).not.toContain(".pruneAgainstDrafts(");
    expect(useMediaLibrary).not.toContain("targetApplying:");
    expect(useMediaLibrary).toContain(
      '"resolve_media_library_session_verification_outcome"',
    );
    expect(useMediaLibrary).toContain(
      '"dismiss_media_library_session_verification_outcomes"',
    );
  });

  it("consumes Rust-batched file deltas without legacy frontend scan buffering", () => {
    expect(useMediaLibrary).toBeDefined();
    expect(useMediaLibrary).toContain('"media_library_session_files_added"');
    expect(useMediaLibrary).not.toContain('api.listen("scan_complete"');
    expect(useMediaLibrary).not.toContain("scheduleBatchedFlush");
    expect(useMediaLibrary).not.toContain("fileBufferRef");
    expect(useMediaLibrary).not.toContain("batchTimerRef");
  });

  it("does not retain a frontend apply state controller", () => {
    expect(productionSources).not.toHaveProperty("../targetApplyController.ts");
    expect(useMediaLibrary).toBeDefined();
    expect(useMediaLibrary).toContain("runTargetApplyCommand");
    expect(useMediaLibrary).toContain("cancelTargetApply");
    expect(useMediaLibrary).not.toContain("TargetApplyController");
    expect(useMediaLibrary).not.toContain("applyActiveRef");
    expect(useMediaLibrary).not.toContain("activeApplyPromiseRef");
    expect(useMediaLibrary).not.toContain("onFileError:");
    expect(useMediaLibrary).not.toContain("onFileWarning:");
    expect(useMediaLibrary).toContain(
      '"dismiss_media_library_session_apply_operation"',
    );
    expect(
      generatedSources["../types/generated/MediaLibraryApplyOperation.ts"],
    ).toContain("issues: Array<MediaLibraryApplyIssue>");
  });
});

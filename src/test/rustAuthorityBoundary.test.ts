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
const useBatchImageJob = import.meta.glob<string>(
  "../hooks/useBatchImageJob.ts",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
)["../hooks/useBatchImageJob.ts"];
const rustLib = import.meta.glob<string>("../../src-tauri/src/lib.rs", {
  query: "?raw",
  import: "default",
  eager: true,
})["../../src-tauri/src/lib.rs"];

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
    expect(rustLib).not.toContain('emit("scan_complete"');
  });

  it("does not expose direct draft persistence outside the session boundary", () => {
    expect(rustLib).not.toContain("fn load_metadata_draft_edits(");
    expect(rustLib).not.toContain("            load_metadata_draft_edits,");
    expect(rustLib).toContain(
      "ensure_session_draft_mutation_allowed(&snapshot)?",
    );
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
    expect(rustLib).toContain(
      "fn dismiss_media_library_session_apply_operation(",
    );
    expect(rustLib).toContain("dismiss_media_library_session_apply_operation,");
    expect(rustLib).toContain("session_id: u64");
    expect(rustLib).toContain("operation_id: String");
    expect(
      generatedSources["../types/generated/MediaLibraryApplyOperation.ts"],
    ).toContain("issues: Array<MediaLibraryApplyIssue>");
  });

  it("projects batch jobs from Rust snapshots without consuming worker events", () => {
    expect(useBatchImageJob).toBeDefined();
    expect(useBatchImageJob).toContain("operation.operation_id");
    expect(useBatchImageJob).toContain("operation.requested_paths");
    expect(useBatchImageJob).not.toContain("api.listen(");
    expect(useBatchImageJob).not.toContain("onApplyEdits");
    expect(useBatchImageJob).not.toContain("frontendStagingFailures");
    expect(useMediaLibrary).not.toContain(
      '"stage_media_library_session_describe_drafts"',
    );
    expect(useMediaLibrary).not.toContain(
      '"stage_media_library_session_geocode_drafts"',
    );
    expect(useMediaLibrary).not.toContain(
      '"stage_media_library_session_normalise_drafts"',
    );
  });

  it("requires recoverable Rust identities for session issues and batch work", () => {
    expect(useMediaLibrary).toContain('"record_media_library_session_issue"');
    expect(useMediaLibrary).not.toContain("issue_id: null");
    expect(
      generatedSources["../types/generated/MediaLibraryBatchOperation.ts"],
    ).toContain("requested_paths: Array<string>");
    expect(
      generatedSources["../types/generated/MediaLibraryBatchOperation.ts"],
    ).toContain("request: unknown | null");
    expect(
      generatedSources["../types/generated/MediaLibrarySessionLifecycle.ts"],
    ).toContain('"failed"');
  });
});

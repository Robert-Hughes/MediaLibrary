import { describe, expect, it } from "vitest";

const productionSources = import.meta.glob<string>("../*.ts", {
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
});

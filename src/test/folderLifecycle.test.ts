import { describe, expect, it, vi } from "vitest";
import { createFolderLifecycle } from "../folderLifecycle";
import type { MediaLibrarySessionSnapshot } from "../types";

function session(
  overrides: Partial<MediaLibrarySessionSnapshot> = {},
): MediaLibrarySessionSnapshot {
  return {
    session_id: 1,
    revision: 1,
    lifecycle: "loaded",
    folder: "/files",
    files: [],
    discovery_running: false,
    issues: [],
    metadata: [],
    thumbnails: [],
    drafts: {},
    draft_persistence: { status: "ready" },
    apply_operation: null,
    verification_outcomes: {},
    batch_operations: {},
    ...overrides,
  };
}

describe("shared folder lifecycle", () => {
  it.each(["open", "refresh"] as const)(
    "uses the same guarded phases for %s",
    (intent) => {
      let remaining = 0;
      const lifecycle = createFolderLifecycle(() => remaining);
      lifecycle.projectSnapshot(session());
      expect(lifecycle.beginOpen("/files", intent)).toBe(true);
      expect(lifecycle.getSnapshot()).toMatchObject({
        phase: "opening",
        intent,
        canOpen: false,
        canRefresh: false,
        canClose: false,
      });
      expect(lifecycle.beginOpen("/other", "open")).toBe(false);
      expect(lifecycle.beginClose()).toBe(false);
      lifecycle.projectSnapshot(
        session({ session_id: 2, lifecycle: "opening" }),
      );
      lifecycle.projectSnapshot(
        session({ session_id: 2, discovery_running: true }),
      );
      expect(lifecycle.getSnapshot().phase).toBe("opening");
      lifecycle.finishOpen();
      expect(lifecycle.getSnapshot()).toMatchObject({
        phase: "discovering",
        intent,
        canRefresh: false,
      });
      remaining = 2;
      lifecycle.projectDiscovery(2, false);
      expect(lifecycle.getSnapshot()).toMatchObject({
        phase: "metadata",
        intent,
        canRefresh: false,
      });
      remaining = 0;
      lifecycle.updateProgress();
      expect(lifecycle.getSnapshot()).toMatchObject({
        phase: "ready",
        intent: null,
        canRefresh: true,
      });
    },
  );

  it("recovers opening and metadata phases from Rust and ignores stale discovery", () => {
    const lifecycle = createFolderLifecycle(() => 3);
    lifecycle.projectSnapshot(session({ lifecycle: "opening" }));
    expect(lifecycle.getSnapshot()).toMatchObject({
      phase: "opening",
      intent: "open",
      canRefresh: false,
    });
    lifecycle.projectSnapshot(session({ discovery_running: true }));
    lifecycle.projectDiscovery(9, false);
    expect(lifecycle.getSnapshot().phase).toBe("discovering");
    lifecycle.projectDiscovery(1, false);
    expect(lifecycle.getSnapshot().phase).toBe("metadata");
  });

  it("does not notify the app root for count changes within the metadata phase", () => {
    let remaining = 5;
    const lifecycle = createFolderLifecycle(() => remaining);
    lifecycle.projectSnapshot(session());
    const notify = vi.fn();
    lifecycle.subscribe(notify);
    const original = lifecycle.getSnapshot();
    remaining = 2;
    lifecycle.updateProgress();
    expect(notify).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot()).toBe(original);
    remaining = 0;
    // Action guards read the live projection even before queued notifications.
    expect(lifecycle.getCurrent().canRefresh).toBe(true);
    lifecycle.updateProgress();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("keeps closing guarded until its command settles, and allows retry after an opening failure", () => {
    const lifecycle = createFolderLifecycle(() => 0);
    lifecycle.projectSnapshot(session());
    expect(lifecycle.beginClose()).toBe(true);
    lifecycle.projectSnapshot(
      session({ lifecycle: "idle", session_id: null, folder: null }),
    );
    expect(lifecycle.beginOpen("/other", "open")).toBe(false);
    lifecycle.finishClose();
    expect(lifecycle.getSnapshot().phase).toBe("idle");
    lifecycle.beginOpen("/other", "open");
    lifecycle.projectSnapshot(
      session({ lifecycle: "opening", folder: "/other" }),
    );
    lifecycle.finishOpen(true);
    expect(lifecycle.getSnapshot()).toMatchObject({
      phase: "failed",
      canOpen: true,
      canRefresh: true,
    });
  });
});

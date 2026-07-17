// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MetadataApplyFileResultV5 } from "../types";
import {
  applyTargetDraftEditsV5,
  cancelTargetApplyV5,
  subscribeTargetApplyV5Events,
  type TargetApplyTauriApi,
} from "../targetApplyTauri";

const fileResult = (relativePath = "photo.jpg"): MetadataApplyFileResultV5 => ({
  relative_path: relativePath,
  applied: true,
  error: null,
  warning: null,
  fresh_image_metadata: {
    relative_path: relativePath,
    occurrences: [],
  },
  target_outcomes: [],
  persisted_draft_entries: [],
});

const batchResult = () => ({
  files: [fileResult()],
  cancelled: false,
  aborted: false,
  abort_reason: null,
});

const duplicateOccurrenceBatchResult = () => {
  const first = {
    id: {
      document: null,
      path: "JPEG-APP1-IFD0",
      tag_id: "282",
      copy: 0,
    },
    schema_id: { table: "Exif::Main", tag_id: "282" },
    value: { kind: "Rational", value: { numerator: 300, denominator: 1 } },
    tag_info: null,
    write_target: null,
  } as const;
  const result = fileResult();
  result.fresh_image_metadata!.occurrences = [first, structuredClone(first)];
  return {
    files: [result],
    cancelled: false,
    aborted: false,
    abort_reason: null,
  };
};

describe("inactive schema-v5 apply invocation", () => {
  it("uses the exact command and copied, ordered arguments", async () => {
    const paths = ["z.jpg", "a.jpg"];
    let received: unknown;
    const invoke = vi.fn(
      async (_command: string, args?: Record<string, unknown>) => {
        received = structuredClone(args);
        (args?.relPaths as string[]).push("backend-mutation.jpg");
        return batchResult();
      },
    );

    await applyTargetDraftEditsV5({ invoke }, "C:\\Media", paths);

    expect(invoke.mock.calls[0]?.[0]).toBe("apply_metadata_draft_edits_v5_cmd");
    expect(received).toEqual({
      folderPath: "C:\\Media",
      relPaths: ["z.jpg", "a.jpg"],
    });
    expect(paths).toEqual(["z.jpg", "a.jpg"]);
  });

  it("rejects duplicate requested paths before invoking", async () => {
    const invoke = vi.fn(async () => batchResult());
    await expect(
      applyTargetDraftEditsV5({ invoke }, "folder", ["same.jpg", "same.jpg"]),
    ).rejects.toThrow(/Duplicate.*same\.jpg/);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("parses valid unknown results and rejects malformed results", async () => {
    await expect(
      applyTargetDraftEditsV5(
        { invoke: vi.fn(async () => batchResult()) },
        "folder",
        ["photo.jpg"],
      ),
    ).resolves.toEqual(batchResult());
    await expect(
      applyTargetDraftEditsV5(
        { invoke: vi.fn(async () => ({ files: "bad" })) },
        "folder",
        [],
      ),
    ).rejects.toThrow(/files must be an array/);
  });

  it("rejects duplicate occurrence IDs without returning a partial result", async () => {
    const raw = duplicateOccurrenceBatchResult();
    await expect(
      applyTargetDraftEditsV5({ invoke: vi.fn(async () => raw) }, "folder", [
        "photo.jpg",
      ]),
    ).rejects.toThrow(/duplicate occurrence ID.*indexes 0 and 1/);
    expect(raw.files[0].fresh_image_metadata?.occurrences).toHaveLength(2);
  });

  it.each([new Error("busy"), { code: "load/apply", detail: "failed" }])(
    "propagates backend apply error unchanged %#",
    async (backendError) => {
      const invoke = vi.fn(async () => {
        throw backendError;
      });
      await expect(
        applyTargetDraftEditsV5({ invoke }, "folder", []),
      ).rejects.toBe(backendError);
    },
  );

  it("uses the exact no-argument cancellation command", async () => {
    const invoke = vi.fn(async () => undefined);
    await cancelTargetApplyV5({ invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0]).toEqual(["cancel_apply_edits_v5"]);
  });

  it("propagates cancellation errors unchanged", async () => {
    const backendError = new Error("cancel failed");
    const invoke = vi.fn(async () => {
      throw backendError;
    });
    await expect(cancelTargetApplyV5({ invoke })).rejects.toBe(backendError);
  });
});

describe("inactive schema-v5 apply event subscription", () => {
  afterEach(() => vi.restoreAllMocks());

  function fakeListeners() {
    const listeners = new Map<string, (payload: unknown) => void>();
    const unregisters = new Map<string, ReturnType<typeof vi.fn>>();
    const listen: TargetApplyTauriApi["listen"] = vi.fn(
      async (event, handler) => {
        listeners.set(event, handler);
        const unregister = vi.fn(() => listeners.delete(event));
        unregisters.set(event, unregister);
        return unregister;
      },
    );
    return { listen, listeners, unregisters };
  }

  it("registers only the exact versioned event names", async () => {
    const fake = fakeListeners();
    await subscribeTargetApplyV5Events(fake, {});
    expect(fake.listen).toHaveBeenNthCalledWith(
      1,
      "apply_edits_v5_started",
      expect.any(Function),
    );
    expect(fake.listen).toHaveBeenNthCalledWith(
      2,
      "apply_metadata_edits_v5_progress",
      expect.any(Function),
    );
    expect([...fake.listeners.keys()]).not.toContain("apply_edits_started");
    expect([...fake.listeners.keys()]).not.toContain(
      "apply_metadata_edits_progress",
    );
  });

  it("delivers valid typed started and complete progress payloads", async () => {
    const fake = fakeListeners();
    const onStarted = vi.fn();
    const onProgress = vi.fn();
    await subscribeTargetApplyV5Events(fake, { onStarted, onProgress });

    fake.listeners.get("apply_edits_v5_started")?.({ total: 0 });
    fake.listeners.get("apply_metadata_edits_v5_progress")?.({
      current: 1,
      total: 1,
      result: fileResult(),
    });

    expect(onStarted).toHaveBeenCalledWith({ total: 0 });
    expect(onProgress).toHaveBeenCalledWith({
      current: 1,
      total: 1,
      result: fileResult(),
    });
  });

  it("routes malformed payloads only to the protocol-error handler", async () => {
    const fake = fakeListeners();
    const onStarted = vi.fn();
    const onProgress = vi.fn();
    const onProtocolError = vi.fn();
    await subscribeTargetApplyV5Events(fake, {
      onStarted,
      onProgress,
      onProtocolError,
    });
    const badStarted = { total: -1 };
    const badProgress = { current: 0, total: 1, result: fileResult() };

    expect(() =>
      fake.listeners.get("apply_edits_v5_started")?.(badStarted),
    ).not.toThrow();
    expect(() =>
      fake.listeners.get("apply_metadata_edits_v5_progress")?.(badProgress),
    ).not.toThrow();

    expect(onStarted).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenNthCalledWith(
      1,
      expect.any(Error),
      "apply_edits_v5_started",
      badStarted,
    );
    expect(onProtocolError).toHaveBeenNthCalledWith(
      2,
      expect.any(Error),
      "apply_metadata_edits_v5_progress",
      badProgress,
    );
  });

  it("routes duplicate-occurrence progress only to protocol error with raw payload", async () => {
    const fake = fakeListeners();
    const onProgress = vi.fn();
    const onProtocolError = vi.fn();
    await subscribeTargetApplyV5Events(fake, {
      onProgress,
      onProtocolError,
    });
    const rawPayload = {
      current: 1,
      total: 1,
      result: duplicateOccurrenceBatchResult().files[0],
    };

    expect(() =>
      fake.listeners.get("apply_metadata_edits_v5_progress")?.(rawPayload),
    ).not.toThrow();
    expect(onProgress).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/duplicate occurrence ID/),
      }),
      "apply_metadata_edits_v5_progress",
      rawPayload,
    );
  });

  it("logs malformed payloads when no protocol-error handler exists", async () => {
    const fake = fakeListeners();
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await subscribeTargetApplyV5Events(fake, {});
    expect(() =>
      fake.listeners.get("apply_edits_v5_started")?.({ total: NaN }),
    ).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("apply_edits_v5_started"),
      expect.any(Error),
      { total: NaN },
    );
  });

  it("atomically unregisters started if progress registration fails", async () => {
    const registrationError = new Error("listen failed");
    const unregisterStarted = vi.fn();
    const listen = vi
      .fn<TargetApplyTauriApi["listen"]>()
      .mockResolvedValueOnce(unregisterStarted)
      .mockRejectedValueOnce(registrationError);

    await expect(subscribeTargetApplyV5Events({ listen }, {})).rejects.toBe(
      registrationError,
    );
    expect(unregisterStarted).toHaveBeenCalledTimes(1);
  });

  it("returns cleanup that unregisters both listeners exactly once", async () => {
    const fake = fakeListeners();
    const cleanup = await subscribeTargetApplyV5Events(fake, {});
    cleanup();
    cleanup();
    expect(
      fake.unregisters.get("apply_edits_v5_started"),
    ).toHaveBeenCalledTimes(1);
    expect(
      fake.unregisters.get("apply_metadata_edits_v5_progress"),
    ).toHaveBeenCalledTimes(1);
  });

  it("does not mutate unrelated frontend state", async () => {
    const fake = fakeListeners();
    const state = Object.freeze({ draftCount: 2, metadataVersion: 4 });
    await subscribeTargetApplyV5Events(fake, {
      onProgress: () => undefined,
    });
    fake.listeners.get("apply_metadata_edits_v5_progress")?.({
      current: 1,
      total: 1,
      result: fileResult(),
    });
    expect(state).toEqual({ draftCount: 2, metadataVersion: 4 });
  });
});

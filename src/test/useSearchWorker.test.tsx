import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSearchWorker,
  type SearchWorkerLike,
} from "../hooks/useSearchWorker";
import { _clearTagInfoCache } from "../hooks/useTagInfo";
import { SearchIndex } from "../search/searchIndex";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import {
  FileMetadataOccurrencesStore,
  type FileInfo,
  type TagInfo,
} from "../types";
import type {
  SearchWorkerInbound,
  SearchWorkerOutbound,
} from "../workers/searchWorkerProtocol";
import { makeFile, testId } from "./factories";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

class FakeWorker implements SearchWorkerLike {
  readonly index = new SearchIndex();
  readonly inbound: SearchWorkerInbound[] = [];
  onmessage: ((event: MessageEvent<SearchWorkerOutbound>) => void) | null =
    null;
  terminated = false;

  postMessage(message: SearchWorkerInbound) {
    this.inbound.push(message);
    switch (message.type) {
      case "CLEAR":
        this.index.clear();
        break;
      case "INIT_PHOTOS":
        message.files.forEach((file) => this.index.setFile(file));
        break;
      case "INIT_OCCURRENCES":
        this.index.setSchemaLabels(message.schemaLabels);
        message.entries.forEach(({ path, occurrences }) =>
          this.index.setOccurrences(path, occurrences),
        );
        break;
      case "INIT_DRAFTS":
        this.index.setSchemaLabels(message.schemaLabels);
        message.entries.forEach(({ path, edits }) =>
          this.index.setDrafts(path, edits),
        );
        break;
      case "UPSERT_PHOTO":
        this.index.setFile(message.file);
        break;
      case "UPSERT_OCCURRENCES":
        this.index.setOccurrences(
          message.path,
          message.occurrences,
          message.schemaLabels,
        );
        break;
      case "UPSERT_DRAFTS":
        this.index.setDrafts(message.path, message.edits, message.schemaLabels);
        break;
      case "DELETE_PATH":
        this.index.deletePath(message.path);
        break;
      case "QUERY": {
        const result = this.index.query(message.query);
        queueMicrotask(() =>
          this.onmessage?.({
            data: { type: "RESULT", id: message.id, ...result },
          } as MessageEvent<SearchWorkerOutbound>),
        );
        break;
      }
    }
  }

  terminate() {
    this.terminated = true;
  }
}

interface HookArgs {
  files: FileInfo[];
  fileMetadataOccurrencesStore: FileMetadataOccurrencesStore;
  targetDraftEditsStore: TargetDraftEditsStore;
  query: string;
}

function setup(initial: Partial<HookArgs> = {}) {
  const fake = new FakeWorker();
  const props: HookArgs = {
    files: initial.files ?? [],
    fileMetadataOccurrencesStore:
      initial.fileMetadataOccurrencesStore ??
      new FileMetadataOccurrencesStore(),
    targetDraftEditsStore:
      initial.targetDraftEditsStore ?? new TargetDraftEditsStore(),
    query: initial.query ?? "",
  };
  const rendered = renderHook(
    (args: HookArgs) =>
      useSearchWorker({
        ...args,
        debounceMs: 0,
        createWorker: () => fake,
      }),
    { initialProps: props },
  );
  return { fake, props, ...rendered };
}

const cityId = testId("XMP-fileshop:City");
const cityInfo: TagInfo = {
  id: cityId,
  group: "XMP-fileshop",
  name: "City",
  writable: true,
  kind: { kind: "Text" },
  description: "City where the image was made",
};

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  _clearTagInfoCache();
  vi.mocked(invoke).mockResolvedValue([cityInfo]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useSearchWorker target-draft projection", () => {
  it("replays complete reserved-path drafts and searches value, exact ID, friendly name, description, and has:edits", async () => {
    const path = "__proto__";
    const drafts = new TargetDraftEditsStore();
    drafts.setMetadataTarget(
      path,
      {
        kind: "NewProperty",
        schema_id: cityId,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      { intent: "Set", value: { kind: "Text", value: "Reykjavik draft" } },
    );
    const file = makeFile({ relative_path: path, filename: "reserved.jpg" });
    const { result, rerender, props } = setup({
      files: [file],
      targetDraftEditsStore: drafts,
      query: "Reykjavik draft",
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set([path])),
    );

    for (const query of [
      "XMP::fileshop",
      "XMP-fileshop:City",
      "City where the image was made",
      "has:edits",
    ]) {
      rerender({ ...props, query });
      await waitFor(() =>
        expect(result.current.matched).toEqual(new Set([path])),
      );
    }
  });

  it("indexes incremental target updates and removes the last draft for a path", async () => {
    const drafts = new TargetDraftEditsStore();
    const file = makeFile({ relative_path: "a.jpg" });
    const { result } = setup({
      files: [file],
      targetDraftEditsStore: drafts,
      query: "has:edits",
    });
    await waitFor(() => expect(result.current.matched).toEqual(new Set()));
    const target = {
      kind: "NewProperty" as const,
      schema_id: cityId,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    act(() => {
      drafts.setMetadataTarget("a.jpg", target, {
        intent: "Set",
        value: { kind: "Text", value: "incremental" },
      });
    });
    await waitFor(() =>
      expect(result.current.matched).toEqual(new Set(["a.jpg"])),
    );
    act(() => drafts.deleteTarget("a.jpg", target));
    await waitFor(() => expect(result.current.matched).toEqual(new Set()));
  });

  it("retries an unchanged initial target snapshot after tag-info failure", async () => {
    const drafts = new TargetDraftEditsStore();
    drafts.setMetadataTarget(
      "a.jpg",
      {
        kind: "NewProperty",
        schema_id: cityId,
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      { intent: "Set", value: { kind: "Text", value: "retry value" } },
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce([cityInfo]);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { fake } = setup({
      files: [makeFile({ relative_path: "a.jpg" })],
      targetDraftEditsStore: drafts,
    });
    await act(async () => void (await Promise.resolve()));
    expect(fake.inbound.some(({ type }) => type === "INIT_DRAFTS")).toBe(false);
    await act(async () => void (await vi.advanceTimersByTimeAsync(250)));
    expect(
      fake.inbound.some(
        (message) =>
          message.type === "INIT_DRAFTS" &&
          message.entries[0]?.path === "a.jpg",
      ),
    ).toBe(true);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("get_tag_infos"),
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it("drops stale draft enrichment and emits only the newest revision", async () => {
    let resolveInfo!: (value: TagInfo[]) => void;
    vi.mocked(invoke).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInfo = resolve;
      }),
    );
    const drafts = new TargetDraftEditsStore();
    const { fake } = setup({ targetDraftEditsStore: drafts });
    await waitFor(() =>
      expect(fake.inbound.some(({ type }) => type === "INIT_DRAFTS")).toBe(
        true,
      ),
    );
    fake.inbound.length = 0;
    const target = {
      kind: "NewProperty" as const,
      schema_id: cityId,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    act(() => {
      drafts.setMetadataTarget("a.jpg", target, {
        intent: "Set",
        value: { kind: "Text", value: "old" },
      });
      drafts.setMetadataTarget("a.jpg", target, {
        intent: "Set",
        value: { kind: "Text", value: "new" },
      });
    });
    resolveInfo([cityInfo]);
    await waitFor(() => {
      const updates = fake.inbound.filter(
        (message) => message.type === "UPSERT_DRAFTS",
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        edits: [{ edit: { value: { value: "new" } } }],
      });
    });
  });
});

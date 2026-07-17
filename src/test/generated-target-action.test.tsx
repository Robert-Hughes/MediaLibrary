import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMediaLibrary } from "../useMediaLibrary";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";
import type {
  MetadataDraftEntry,
  MetadataOccurrence,
  SchemaDefinitionId,
} from "../types";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto } from "./factories";

function occurrence(
  id: SchemaDefinitionId,
  value = "current",
  options: { copy?: number; writable?: boolean; writeTarget?: boolean } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: "JPEG-APP1-XMP",
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: id.tag_id,
        index: null,
      },
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(id),
    value: { kind: "Text", value },
    tag_info: {
      id,
      group: "XMP-mlib",
      name: id.tag_id,
      writable: options.writable ?? true,
      kind: { kind: "Text" },
      description: null,
    },
    write_target:
      options.writeTarget === false
        ? null
        : { group1: "XMP-mlib", group7: "ID-Test", tag_name: id.tag_id },
  };
}

const generated = (
  id: SchemaDefinitionId,
  value: string,
): MetadataDraftEntry => ({
  id,
  edit: { intent: "Set", value: { kind: "Text", value } },
});

async function loadedFile(
  options: {
    occurrences?: MetadataOccurrence[];
    emitMetadata?: boolean;
    targetLoadFails?: boolean;
  } = {},
) {
  const mock = createMockTauriApi();
  mock.pickFolderResolves("/photos");
  const api = options.targetLoadFails
    ? {
        ...mock.api,
        invoke: (cmd: string, args?: Record<string, unknown>) =>
          cmd === "load_metadata_draft_edits_v5"
            ? Promise.reject(new Error("broken target drafts"))
            : mock.api.invoke(cmd, args),
      }
    : mock.api;
  const hook = renderHook(() => useMediaLibrary(api));
  await act(async () => hook.result.current[1].openFolder());
  act(() => {
    mock.emitPhotoFound(makePhoto({ relative_path: "photo.jpg" }));
    mock.emitScanComplete();
    if (options.emitMetadata !== false) {
      mock.emitImageMetadataReady(
        "photo.jpg",
        {},
        undefined,
        options.occurrences ?? [],
      );
    }
  });
  return { mock, ...hook };
}

function saveCount(
  mock: ReturnType<typeof createMockTauriApi>,
  command: string,
): number {
  return mock.invocations.filter(({ cmd }) => cmd === command).length;
}

describe("generated schema-v5 production action", () => {
  it("treats empty edits as unchanged without errors, notifications, or saves", async () => {
    const { mock, result } = await loadedFile();
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    let notifications = 0;
    const unsubscribe = state.targetDraftEditsStore.subscribe(() => {
      notifications += 1;
    });
    const errorsBefore = state.workerErrors.length;
    const v5Before = saveCount(mock, "save_metadata_draft_edits_v5");
    let stageResult;

    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [],
      );
    });
    unsubscribe();

    expect(stageResult).toEqual({ kind: "success", changed: false });
    expect(notifications).toBe(0);
    expect(result.current[0].kind).toBe("loaded");
    if (result.current[0].kind !== "loaded") return;
    expect(result.current[0].workerErrors).toHaveLength(errorsBefore);
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - v5Before).toBe(0);
  });

  it("treats empty edits as unchanged while occurrences are loading", async () => {
    const { result } = await loadedFile({ emitMetadata: false });
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [],
      );
    });
    expect(stageResult).toEqual({ kind: "success", changed: false });
  });

  it("treats empty edits as unchanged when target persistence load failed", async () => {
    const { mock, result } = await loadedFile({ targetLoadFails: true });
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    expect(state.targetDraftPersistence.status).toBe("load-failed");
    const errorsBefore = state.workerErrors.length;
    const v5Before = saveCount(mock, "save_metadata_draft_edits_v5");
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [],
      );
    });
    expect(stageResult).toEqual({ kind: "success", changed: false });
    if (result.current[0].kind !== "loaded") return;
    expect(result.current[0].workerErrors).toHaveLength(errorsBefore);
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - v5Before).toBe(0);
  });

  it("still rejects a non-empty result when target persistence is unavailable", async () => {
    const { result } = await loadedFile({ targetLoadFails: true });
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "generated")],
      );
    });
    expect(stageResult).toMatchObject({ kind: "failure" });
  });

  it("blocks apply after a strict target-draft load failure", async () => {
    const { mock, result } = await loadedFile({ targetLoadFails: true });

    await expect(
      result.current[1].applyDraftEdits("photo.jpg"),
    ).rejects.toThrow("Target-aware drafts could not be loaded safely");
    expect(
      mock.invocations.some(
        ({ cmd }) => cmd === "apply_metadata_draft_edits_v5_cmd",
      ),
    ).toBe(false);
  });

  it("resets a strict load failure when a different folder loads successfully", async () => {
    const mock = createMockTauriApi();
    mock.pickFolderResolves("/broken");
    let targetLoads = 0;
    const api = {
      ...mock.api,
      invoke: (cmd: string, args?: Record<string, unknown>) => {
        if (cmd === "load_metadata_draft_edits_v5" && targetLoads++ === 0) {
          return Promise.reject(new Error("broken target drafts"));
        }
        return mock.api.invoke(cmd, args);
      },
    };
    const { result } = renderHook(() => useMediaLibrary(api));

    await act(async () => result.current[1].openFolder());
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "broken.jpg" }));
      mock.emitScanComplete();
    });
    expect(result.current[0].kind).toBe("loaded");
    if (result.current[0].kind !== "loaded") return;
    expect(result.current[0].targetDraftPersistence.status).toBe("load-failed");

    await act(async () => result.current[1].openRecent("/valid"));
    act(() => {
      mock.emitPhotoFound(makePhoto({ relative_path: "valid.jpg" }));
      mock.emitScanComplete();
      mock.emitImageMetadataReady("valid.jpg", {}, undefined, []);
    });
    expect(result.current[0].kind).toBe("loaded");
    if (result.current[0].kind !== "loaded") return;
    expect(result.current[0].folder).toBe("/valid");
    expect(result.current[0].targetDraftPersistence).toEqual({
      status: "ready",
    });

    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "valid.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "valid")],
      );
    });
    expect(stageResult).toEqual({ kind: "success", changed: true });
  });

  it("still rejects a non-empty result while occurrences are loading", async () => {
    const { result } = await loadedFile({ emitMetadata: false });
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "generated")],
      );
    });
    expect(stageResult).toMatchObject({ kind: "failure" });
  });

  it("stages a missing describe field only as NewProperty and autosaves v5 once", async () => {
    const { mock, result } = await loadedFile();
    const beforeV5 = saveCount(mock, "save_metadata_draft_edits_v5");

    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "generated")],
      );
    });

    expect(stageResult).toEqual({ kind: "success", changed: true });
    const state = result.current[0];
    expect(state.kind).toBe("loaded");
    if (state.kind !== "loaded") return;
    const entries = Object.values(state.targetDraftEdits["photo.jpg"] ?? {});
    expect(entries).toHaveLength(1);
    expect(entries[0].target).toEqual({
      kind: "NewProperty",
      schema_id: ID.mlibAiDescription,
      write_target: {
        group1: "XMP-mlib",
        group7: "ID-AIDescription",
        tag_name: "AIDescription",
      },
    });
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - beforeV5).toBe(1);
  });

  it("stages a unique existing occurrence through its full runtime target", async () => {
    const item = occurrence(ID.mlibAiDescription);
    const { result } = await loadedFile({ occurrences: [item] });
    act(() => {
      result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "generated")],
      );
    });
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    expect(
      Object.values(state.targetDraftEdits["photo.jpg"])[0].target,
    ).toEqual({
      kind: "ExistingOccurrence",
      occurrence_id: item.id,
      schema_id: ID.mlibAiDescription,
      write_target: item.write_target,
    });
  });

  it("uses one atomic store notification and save for a multi-field file batch", async () => {
    const { mock, result } = await loadedFile();
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    let notifications = 0;
    const unsubscribe = state.targetDraftEditsStore.subscribe(() => {
      notifications += 1;
    });
    const before = saveCount(mock, "save_metadata_draft_edits_v5");
    act(() => {
      result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [
          generated(ID.mlibAiDescription, "description"),
          generated(ID.mlibAiTags, "tags"),
        ],
      );
    });
    unsubscribe();
    expect(notifications).toBe(1);
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - before).toBe(1);
  });

  it("emits no notification or save for an exact generated no-op", async () => {
    const item = occurrence(ID.mlibAiDescription, "same");
    const { mock, result } = await loadedFile({ occurrences: [item] });
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    let notifications = 0;
    const unsubscribe = state.targetDraftEditsStore.subscribe(() => {
      notifications += 1;
    });
    const before = saveCount(mock, "save_metadata_draft_edits_v5");
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "same")],
      );
    });
    unsubscribe();
    expect(stageResult).toEqual({ kind: "success", changed: false });
    expect(notifications).toBe(0);
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - before).toBe(0);
  });

  it("leaves the complete file unchanged when a later generated field is invalid", async () => {
    const { mock, result } = await loadedFile();
    const before = saveCount(mock, "save_metadata_draft_edits_v5");
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [
          generated(ID.mlibAiDescription, "valid"),
          generated(ID.xmpTitle, "foreign"),
        ],
      );
    });
    expect(stageResult).toMatchObject({ kind: "failure" });
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    expect(state.targetDraftEdits["photo.jpg"]).toBeUndefined();
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - before).toBe(0);
  });
  it("readiness prevents work while occurrences are loading", async () => {
    const { mock, result } = await loadedFile({ emitMetadata: false });
    let ready;
    act(() => {
      ready = result.current[1].canStageGeneratedMetadataV5(["photo.jpg"]);
    });
    expect(ready).toBe(false);
    expect(
      mock.invocations.some(({ cmd }) => cmd === "describe_images_cmd"),
    ).toBe(false);
    const state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    expect(state.workerErrors[state.workerErrors.length - 1]?.worker_type).toBe(
      "metadata-v5-generated-readiness",
    );
  });

  it("does not mutate caller-owned generated entries", async () => {
    const { result } = await loadedFile();
    const entry = generated(ID.mlibAiDescription, "generated");
    act(() => {
      result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [entry],
      );
    });
    expect(entry).toEqual(generated(ID.mlibAiDescription, "generated"));
  });
});

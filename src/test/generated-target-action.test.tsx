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
      tag_id: id.tag_id,
      copy: options.copy ?? 0,
    },
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
        : { group1: "XMP-mlib", tag_name: id.tag_id },
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
  options: { occurrences?: MetadataOccurrence[]; emitMetadata?: boolean } = {},
) {
  const mock = createMockTauriApi();
  mock.pickFolderResolves("/photos");
  const hook = renderHook(() => useMediaLibrary(mock.api));
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
  it("stages a missing describe field only as NewProperty and autosaves v5 once", async () => {
    const { mock, result } = await loadedFile();
    const beforeV5 = saveCount(mock, "save_metadata_draft_edits_v5");
    const beforeV4 = saveCount(mock, "save_metadata_draft_edits");

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
    });
    expect(state.draftEdits["photo.jpg"]).toBeUndefined();
    expect(saveCount(mock, "save_metadata_draft_edits_v5") - beforeV5).toBe(1);
    expect(saveCount(mock, "save_metadata_draft_edits") - beforeV4).toBe(0);
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
  it("blocks an exact legacy owner and preserves both stores", async () => {
    const { mock, result } = await loadedFile();
    let state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    const legacyStore = state.draftEditsStore;
    act(() => {
      legacyStore.setMetadataBatch("photo.jpg", [
        generated(ID.mlibAiDescription, "legacy"),
      ]);
    });
    const before = saveCount(mock, "save_metadata_draft_edits_v5");
    let stageResult;
    act(() => {
      stageResult = result.current[1].applyGeneratedMetadataDraftBatchV5(
        "photo.jpg",
        { kind: "describe" },
        [generated(ID.mlibAiDescription, "generated")],
      );
    });
    expect(stageResult).toMatchObject({ kind: "failure" });
    state = result.current[0];
    if (state.kind !== "loaded") throw new Error("Expected loaded state");
    expect(state.draftEdits["photo.jpg"]).toBeDefined();
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

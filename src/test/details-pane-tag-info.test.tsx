import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type { MetadataOccurrence, SchemaDefinitionId, TagInfo } from "../types";
import { makeFile } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const file = makeFile({ relative_path: "tag-info.jpg" });
const id: SchemaDefinitionId = { table: "XMP::dc", tag_id: "title" };
const registryInfo: TagInfo = {
  id,
  group: "XMP-dc",
  name: "Registry title",
  writable: true,
  kind: { kind: "Text" },
  description: null,
};

function occurrence(copy = 0): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: `XMP-${copy}`,
      runtime_tag_id: "title",
      tag_id_scope: { table: "XMP::dc", tag_id: "title", index: null },
      copy,
    },
    schema_id: id,
    value: { kind: "Text", value: `value ${copy}` },
    observed_selector: {
      group1: "XMP-dc",
      group7: "ID-title",
      tag_name: "Title",
    },
    write_target: {
      group1: "XMP-dc",
      group7: "ID-title",
      tag_name: "Title",
    },
  };
}

function renderPane(
  occurrences: MetadataOccurrence[],
  targetDraftEdits?: Parameters<typeof DetailsPane>[0]["targetDraftEdits"],
) {
  render(
    <DetailsPane
      file={file}
      occurrences={occurrences}
      targetDraftEdits={targetDraftEdits}
      targetDraftPersistence={{ status: "ready" }}
      onSetExistingOccurrenceDraft={vi.fn()}
      onSetNewPropertyDraft={vi.fn(async () => true)}
      onReplaceNewPropertyDraftTarget={vi.fn(async () => true)}
      onRemoveMetadataTargets={vi.fn(() => true)}
      onDiscardTargetPropertyDraft={vi.fn()}
      onDiscardTargetDraftBatch={vi.fn(() => true)}
    />,
  );
}

beforeEach(() => {
  _clearTagInfoCache();
  vi.mocked(invoke).mockReset();
});

afterEach(() => {
  cleanup();
  _clearTagInfoCache();
});

describe("DetailsPane schema registry", () => {
  it("uses exact startup-registry information synchronously without schema IPC", () => {
    _setTagInfoCacheEntry(id, registryInfo);
    renderPane([occurrence()]);

    expect(screen.getByText("Registry title")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps an exact registry miss read-only without guessing or schema IPC", () => {
    _setTagInfoCacheEntry(id, null);
    renderPane([occurrence()]);

    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reuses one exact registry definition for multiple same-schema occurrences", () => {
    _setTagInfoCacheEntry(id, registryInfo);
    renderPane([occurrence(0), occurrence(1)]);

    expect(screen.getAllByText("Registry title")).toHaveLength(2);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps a same-schema New Property editable from the exact registry", () => {
    _setTagInfoCacheEntry(id, registryInfo);
    const target = {
      kind: "NewProperty" as const,
      schema_id: id,
      write_target: {
        group1: "XMP-custom",
        group7: "ID-title",
        tag_name: "Title",
      },
    };
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(file.relative_path, target, {
      intent: "Set",
      value: { kind: "Text", value: "draft" },
    });
    renderPane([occurrence()], store.getMetadataFile(file.relative_path));

    const newRow = screen
      .getAllByTestId("details-row")
      .find((row) => row.dataset.rowKind === "NewPropertyRow");
    if (!newRow) throw new Error("New Property row not found");
    expect(newRow).toHaveTextContent("Registry title");
    fireEvent.contextMenu(newRow);
    expect(
      screen.getByRole("button", { name: "Edit value…" }),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });
});

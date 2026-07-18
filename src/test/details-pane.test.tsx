import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
/**
 * DetailsPane component tests.
 *
 * Tests cover:
 * - Rendering OS metadata from PhotoInfo
 * - Rendering grouped image metadata by prefix
 * - Loading state display
 * - Empty metadata state display
 * - Utility function correctness (grouping, formatting)
 */
import { useState } from "react";
import {
  render,
  screen,
  within,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import {
  TargetDraftEditsStore,
  type TargetDraftCollection,
} from "../targetDraftEdits";
import { planGpsTargetDraftBatch } from "../gpsTargetDrafts";
import { knownMetadataWriteTarget } from "../metadata/knownIds";

import {
  groupImageMetadata as exactGroupImageMetadata,
  formatMetadataValue,
  formatTimestamp,
  getOsEntries,
} from "../utils/detailsPaneHelpers";
import { makePhoto, mockMetadata, testFriendlyName, testId } from "./factories";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";
import {
  _resetWritableSchemaDefinitionsCache as _resetSchemaTagNamesCache,
  _setWritableSchemaDefinitionsCache as _setSchemaTagNamesCache,
} from "../hooks/useWritableSchemaDefinitions";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  ImageMetadataEntry,
  MetadataOccurrence,
  MetadataTargetDraftEntry,
  PhotoInfo,
  SchemaDefinitionId,
} from "../types";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

function mockOccurrences(
  values: Parameters<typeof mockMetadata>[0],
  readOnly: string[] = [],
): MetadataOccurrence[] {
  return Object.values(mockMetadata(values)).map((entry, index) => {
    const friendly = testFriendlyName(entry.id);
    const separator = friendly.indexOf(":");
    const group = separator < 0 ? "Other" : friendly.slice(0, separator);
    const name = separator < 0 ? friendly : friendly.slice(separator + 1);
    const value = { ...entry } as Record<string, unknown>;
    delete value.id;
    return {
      id: {
        document: null,
        path: `TEST-${group}-${index}`,
        runtime_tag_id: entry.id.tag_id,
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: entry.id.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: structuredClone(entry.id),
      value: value as MetadataOccurrence["value"],
      tag_info: {
        id: structuredClone(entry.id),
        group,
        name,
        writable: !readOnly.includes(friendly),
        kind: { kind: "Text" },
        description: null,
      },
      observed_selector: { group1: group, group7: "ID-Test", tag_name: name },
      write_target: readOnly.includes(friendly)
        ? null
        : { group1: group, group7: "ID-Test", tag_name: name },
    };
  });
}

const groupImageMetadata = (metadata: Record<string, ImageMetadataEntry>) => {
  const infos = Object.fromEntries(
    Object.values(metadata).map((entry) => {
      const friendly = testFriendlyName(entry.id);
      const colon = friendly.indexOf(":");
      return [
        schemaDefinitionIdToken(entry.id),
        {
          id: entry.id,
          group: colon > 0 ? friendly.slice(0, colon) : "Other",
          name: colon > 0 ? friendly.slice(colon + 1) : friendly,
          writable: true,
          kind: { kind: "Text" as const },
          description: null,
        },
      ];
    }),
  );
  return exactGroupImageMetadata(metadata, infos).map((group) => ({
    ...group,
    entries: group.entries.map(({ id, label, value }) => ({
      label,
      value,
      fullKey: testFriendlyName(id),
    })),
  }));
};
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

// ── Utility function tests ───────────────────────────────────────────────────

describe("formatMetadataValue", () => {
  it("formats a string value", () => {
    expect(formatMetadataValue({ kind: "Text", value: "Canon" })).toBe("Canon");
  });

  it("formats a numeric value", () => {
    expect(formatMetadataValue({ kind: "Real", value: 42 })).toBe("42");
  });

  it("formats an array value as comma-separated", () => {
    expect(
      formatMetadataValue({
        kind: "List",
        value: {
          list_kind: "Unknown",
          items: [
            { kind: "Text", value: "landscape" },
            { kind: "Text", value: "nature" },
          ],
        },
      }),
    ).toBe("landscape, nature");
  });

  it("formats nested arrays", () => {
    expect(
      formatMetadataValue({
        kind: "List",
        value: {
          list_kind: "Unknown",
          items: [
            {
              kind: "List",
              value: {
                list_kind: "Unknown",
                items: [
                  { kind: "Text", value: "a" },
                  { kind: "Text", value: "b" },
                ],
              },
            },
            { kind: "Text", value: "c" },
          ],
        },
      }),
    ).toBe("a, b, c");
  });
});

describe("formatTimestamp", () => {
  it("returns a dash for null", () => {
    expect(formatTimestamp(null)).toBe("—");
  });

  it("returns a locale date string for a valid timestamp", () => {
    const ts = 1609459200; // 2021-01-01T00:00:00Z
    const result = formatTimestamp(ts);
    // Should contain year 2021 at minimum
    expect(result).toContain("2021");
  });
});

describe("getOsEntries", () => {
  it("returns entries for all OS metadata fields", () => {
    const photo = makePhoto({
      relative_path: "folder/photo.jpg",
      filename: "photo.jpg",
      date_modified: 1609459200,
      date_created: 1609459200,
    });
    const entries = getOsEntries(photo);
    expect(entries).toHaveLength(4);
    expect(entries.map(([key]) => key)).toEqual([
      "Filename",
      "Relative Path",
      "Date Modified",
      "Date Created",
    ]);
    expect(entries[0][1]).toBe("photo.jpg");
    expect(entries[1][1]).toBe("folder/photo.jpg");
  });
});

describe("groupImageMetadata", () => {
  it("groups entries by prefix and strips prefixes from labels", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
      "IFD0:Model": "EOS R5",
      "XMP-dc:Subject": ["landscape", "nature"],
      "ExifIFD:ISO": 100,
    });
    const groups = groupImageMetadata(metadata);

    expect(groups).toHaveLength(3);

    const exifGroup = groups.find((g) => g.prefix === "ExifIFD");
    expect(exifGroup).toBeDefined();
    expect(exifGroup!.entries).toEqual([
      { label: "ISO", value: "100", fullKey: "ExifIFD:ISO" },
    ]);

    const ifdGroup = groups.find((g) => g.prefix === "IFD0");
    expect(ifdGroup).toBeDefined();
    expect(ifdGroup!.entries).toEqual([
      { label: "Make", value: "Canon", fullKey: "IFD0:Make" },
      { label: "Model", value: "EOS R5", fullKey: "IFD0:Model" },
    ]);

    const xmpGroup = groups.find((g) => g.prefix === "XMP-dc");
    expect(xmpGroup).toBeDefined();
    expect(xmpGroup!.entries).toEqual([
      {
        label: "Subject",
        value: "landscape, nature",
        fullKey: "XMP-dc:Subject",
      },
    ]);
  });

  it('places keys without a colon in "Other" group at the end', () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
      FileSize: "4.2 MB",
      FileName: "photo.jpg",
    });
    const groups = groupImageMetadata(metadata);

    expect(groups[groups.length - 1].prefix).toBe("Other");
    expect(groups[groups.length - 1].entries).toEqual([
      { label: "FileName", value: "photo.jpg", fullKey: "FileName" },
      { label: "FileSize", value: "4.2 MB", fullKey: "FileSize" },
    ]);
  });

  it("sorts groups alphabetically (Other last)", () => {
    const metadata = mockMetadata({
      "XMP-dc:Subject": "test",
      "IFD0:Make": "Canon",
      "ExifIFD:ISO": 100,
      NoPrefix: "value",
    });
    const groups = groupImageMetadata(metadata);
    const prefixes = groups.map((g) => g.prefix);
    expect(prefixes).toEqual(["ExifIFD", "IFD0", "XMP-dc", "Other"]);
  });

  it("returns empty array for empty metadata", () => {
    expect(groupImageMetadata({})).toEqual([]);
  });
});

// ── Component rendering tests ────────────────────────────────────────────────

describe("DetailsPane component", () => {
  const photo = makePhoto({
    relative_path: "2024/vacation/beach.jpg",
    filename: "beach.jpg",
    date_modified: 1609459200,
    date_created: 1609372800,
  });

  beforeEach(() => {
    _clearTagInfoCache();
    const commonTags = [
      "IFD0:Make",
      "IFD0:Model",
      "ExifIFD:ISO",
      "XMP-dc:Subject",
      "GPS:GPSLatitude",
      "GPS:GPSLongitude",
      "GPS:GPSLatitudeRef",
      "GPS:GPSLongitudeRef",
    ];
    for (const tag of commonTags) {
      const colon = tag.indexOf(":");
      _setTagInfoCacheEntry(tag, {
        group: tag.slice(0, colon),
        name: tag.slice(colon + 1),
        writable: true,
        kind: { kind: "Text" },
        description: null,
      });
    }
  });

  it("renders the OS metadata section with all photo properties", () => {
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences="loading"
      />,
    );

    const osSection = screen.getByTestId("details-section-os");
    expect(osSection).toBeInTheDocument();

    expect(within(osSection).getByText("OS Metadata")).toBeInTheDocument();
    expect(within(osSection).getByText("Filename")).toBeInTheDocument();
    expect(within(osSection).getByText("beach.jpg")).toBeInTheDocument();
    expect(within(osSection).getByText("Relative Path")).toBeInTheDocument();
    expect(
      within(osSection).getByText("2024/vacation/beach.jpg"),
    ).toBeInTheDocument();
  });

  it('shows a loading state when metadata is "loading"', () => {
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences="loading"
      />,
    );

    const loadingSection = screen.getByTestId("details-section-loading");
    expect(loadingSection).toBeInTheDocument();
    expect(
      within(loadingSection).getByText("Loading metadata…"),
    ).toBeInTheDocument();
  });

  it("shows empty state when metadata has no keys", () => {
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
      />,
    );

    const emptySection = screen.getByTestId("details-section-empty");
    expect(emptySection).toBeInTheDocument();
    expect(
      within(emptySection).getByText("No image metadata available"),
    ).toBeInTheDocument();
  });

  it("renders grouped image metadata sections", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
      "IFD0:Model": "EOS R5",
      "ExifIFD:ISO": 100,
      "XMP-dc:Subject": ["landscape", "nature"],
    });

    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrencesFromMetadataCollection(metadata)}
      />,
    );

    // Check that group sections are rendered
    const ifdSection = screen.getByTestId("details-section-IFD0");
    expect(ifdSection).toBeInTheDocument();
    expect(within(ifdSection).getByText("IFD0")).toBeInTheDocument();
    expect(within(ifdSection).getByText("Make")).toBeInTheDocument();
    expect(within(ifdSection).getByText("Canon")).toBeInTheDocument();
    expect(within(ifdSection).getByText("Model")).toBeInTheDocument();
    expect(within(ifdSection).getByText("EOS R5")).toBeInTheDocument();

    const exifSection = screen.getByTestId("details-section-ExifIFD");
    expect(exifSection).toBeInTheDocument();
    expect(within(exifSection).getByText("ISO")).toBeInTheDocument();
    expect(within(exifSection).getByText("100")).toBeInTheDocument();

    const xmpSection = screen.getByTestId("details-section-XMP-dc");
    expect(xmpSection).toBeInTheDocument();
    expect(within(xmpSection).getByText("Subject")).toBeInTheDocument();
    expect(
      within(xmpSection).getByText("landscape, nature"),
    ).toBeInTheDocument();
  });

  it("renders schema-backed enum labels for canonical metadata values", () => {
    _clearTagInfoCache();
    _setTagInfoCacheEntry("IFD0:Orientation", {
      group: "IFD0",
      name: "Orientation",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "Integer",
          options: [{ code: "6", label: "Rotate 90 CW" }],
        },
      },
      description: null,
    });

    const [orientation] = occurrencesFromMetadataCollection(
      mockMetadata({ "IFD0:Orientation": 6 }),
    );
    orientation.tag_info = {
      id: structuredClone(orientation.schema_id),
      group: "IFD0",
      name: "Orientation",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "Integer",
          options: [{ code: "6", label: "Rotate 90 CW" }],
        },
      },
      description: null,
      storage_count: undefined,
    };
    orientation.write_target = {
      group1: "IFD0",
      group7: "ID-Test",
      tag_name: "Orientation",
    };
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[orientation]}
      />,
    );

    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("Orientation") !== null);
    expect(row).toBeDefined();
    expect(within(row!).getByText("Rotate 90 CW")).toBeInTheDocument();
    expect(within(row!).queryByText("6")).toBeNull();
    _clearTagInfoCache();
  });

  it("has the Properties title", () => {
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences="loading"
      />,
    );
    expect(screen.getByText("Properties")).toBeInTheDocument();
  });

  it("renders the action buttons in a sticky footer outside the scrolling body", () => {
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
        onGenerateAiDescription={() => {}}
      />,
    );
    const footer = screen.getByTestId("details-pane-footer");
    expect(footer).toBeInTheDocument();
    // The footer must be a sibling of the scroll container, not nested in it.
    const body = footer.parentElement?.querySelector(".details-pane-body");
    expect(body).not.toBeNull();
    expect(body!.contains(footer)).toBe(false);

    // Both action buttons live in the sticky footer.
    expect(within(footer).getByText("+ Add Property…")).toBeInTheDocument();
    expect(
      within(footer).getByTestId("details-pane-generate-ai-btn"),
    ).toBeInTheDocument();
  });

  it("renders a Show in File Explorer button when the callback is wired, and fires it on click", async () => {
    const onShow = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
        onShowInFileExplorer={onShow}
      />,
    );
    const btn = screen.getByTestId("details-pane-show-in-explorer-btn");
    expect(btn).toBeInTheDocument();
    await user.click(btn);
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("omits the Show in File Explorer button when no callback is wired", () => {
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
      />,
    );
    expect(
      screen.queryByTestId("details-pane-show-in-explorer-btn"),
    ).toBeNull();
  });
});

// ── Generate-AI overwrite confirmation ──────────────────────────────────────

describe("DetailsPane: Generate-AI button", () => {
  // The overwrite-warning now lives inside DescribeProgressDialog's
  // awaiting-confirm panel rather than in a pre-dialog `ask()`. The
  // button's only job is to invoke the callback — the dialog (driven by
  // App-level overwriteInfo) takes it from there.
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });
  beforeEach(() => {
    cleanup();
  });

  it("invokes onGenerateAiDescription with no existing description either", async () => {
    const ask = vi.fn();
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ ask }));
    vi.resetModules();
    const { DetailsPane: Fresh } = await import("../components/DetailsPane");
    const onGenerate = vi.fn();
    const user = userEvent.setup();
    render(
      <Fresh
        photo={photo}
        occurrences={[]}
        onGenerateAiDescription={onGenerate}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("details-pane-generate-ai-btn"));
    expect(ask).not.toHaveBeenCalled();
    expect(onGenerate).toHaveBeenCalledTimes(1);
    vi.doUnmock("@tauri-apps/plugin-dialog");
  });
});

// ── Two-step Add-Property flow ──────────────────────────────────────────────

describe("DetailsPane: Add-Property two-step flow", () => {
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
    _resetSchemaTagNamesCache();
    _setSchemaTagNamesCache([]);
  });

  it("stage 2 routes to a kind-appropriate editor (Bag → chip editor)", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Bag", data: { kind: "Text" } },
      description: null,
    });
    _setSchemaTagNamesCache([
      {
        id: testId("XMP-dc:Subject"),
        group: "XMP-dc",
        name: "Subject",
        writable: true,
        kind: { kind: "Bag", data: { kind: "Text" } },
        description: null,
      },
    ]);
    const onSetNewPropertyDraft = vi.fn();
    const onSetExistingOccurrenceDraft = vi.fn();
    const onRemoveMetadataTargets = vi.fn(() => true);

    render(
      <DetailsPane
        onRemoveMetadataTargets={onRemoveMetadataTargets}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onSetNewPropertyDraft={onSetNewPropertyDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Subject" },
    });
    await user.click(screen.getByRole("button", { name: /XMP-dc:Subject/ }));
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    // Stage 1 dialog is gone; stage 2 is the Bag chip editor.
    expect(screen.queryByTestId("new-property-key")).toBeNull();
    expect(screen.getByTestId("bag-editor-overlay")).toBeInTheDocument();

    // Add a chip and save.
    const chipInput = screen.getByTestId("bag-editor-input");
    fireEvent.change(chipInput, { target: { value: "landscape" } });
    fireEvent.keyDown(chipInput, { key: "Enter" });
    await user.click(screen.getByTestId("bag-editor-save"));

    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(onSetNewPropertyDraft).toHaveBeenCalledTimes(1);
    const [targetArg, editArg] = onSetNewPropertyDraft.mock.calls[0] as [
      unknown,
      MetadataDraftEdit,
    ];
    expect(targetArg).toEqual({
      kind: "NewProperty",
      schema_id: testId("XMP-dc:Subject"),
      write_target: {
        group1: "XMP-dc",
        group7: "ID-subject",
        tag_name: "Subject",
      },
    });
    expect(editArg.intent).toBe("Set");
    expect(editArg.value).toEqual({
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [{ kind: "Text", value: "landscape" }],
      },
    });
  });

  it("stage 2 routes Boolean tags to the Boolean editor (proves kind dispatch is not stringly typed)", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-foo:Bool", {
      group: "XMP-foo",
      name: "Bool",
      writable: true,
      kind: { kind: "Boolean" },
      description: null,
    });
    _setSchemaTagNamesCache([
      {
        id: testId("XMP-foo:Bool"),
        group: "XMP-foo",
        name: "Bool",
        writable: true,
        kind: { kind: "Boolean" },
        description: null,
      },
    ]);
    const onSetExistingOccurrenceDraft = vi.fn();
    const onSetNewPropertyDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onSetNewPropertyDraft={onSetNewPropertyDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-foo:Bool" },
    });
    await user.click(screen.getByRole("button", { name: /XMP-foo:Bool/ }));
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    expect(screen.queryByTestId("new-property-key")).toBeNull();
    // BooleanEditor renders true/false radios — assert the dialog is not
    // a plain text input by checking for those radio inputs.
    const radios = screen.getAllByRole("radio");
    expect(radios.length).toBeGreaterThanOrEqual(2);
  });

  it("cancelling stage 2 closes the flow without creating either draft kind", async () => {
    const user = userEvent.setup();
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    _setSchemaTagNamesCache([
      {
        id: testId("XMP-dc:Title"),
        group: "XMP-dc",
        name: "Title",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);
    const onSetExistingOccurrenceDraft = vi.fn();
    const onSetNewPropertyDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={[]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onSetNewPropertyDraft={onSetNewPropertyDraft}
      />,
    );

    await user.click(screen.getByText("+ Add Property…"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    await user.click(screen.getByRole("button", { name: /XMP-dc:Title/ }));
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));

    // Stage 2 should be a ValueEditDialog for Text — cancel it.
    await user.click(screen.getByText("Cancel"));
    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
  });
});

describe("DetailsPane: target-aware Add Property drafts", () => {
  const photo = makePhoto({ relative_path: "target.jpg" });
  const id = testId("XMP-dc:Subject");
  const target = {
    kind: "ExistingOccurrence" as const,
    occurrence_id: {
      document: null,
      path: "JPEG-APP1-XMP",
      runtime_tag_id: "subject",
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: "subject",
        index: null,
      },
      copy: 0,
    },
    schema_id: id,
    write_target: { group1: "XMP-dc", group7: "ID-Test", tag_name: "Subject" },
  };

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  });

  it("enables Add Property when target-aware persistence is ready", async () => {
    const user = userEvent.setup();
    _setSchemaTagNamesCache([]);
    render(
      <DetailsPane
        photo={photo}
        occurrences={[]}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    const button = screen.getByTestId("details-pane-add-property-btn");
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(
      screen.getByRole("dialog", { name: "Add new property" }),
    ).toBeInTheDocument();
  });

  it("disables Add Property and existing-row editing after a failed target-aware load", async () => {
    const user = userEvent.setup();
    const titleId = testId("XMP-dc:Title");
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFromMetadataCollection({
          [schemaDefinitionIdToken(titleId)]: {
            id: titleId,
            kind: "Text",
            value: "existing",
          },
        })}
        targetDraftPersistence={{
          status: "load-failed",
          error: "malformed file",
        }}
        onSetExistingOccurrenceDraft={vi.fn()}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    const button = screen.getByTestId("details-pane-add-property-btn");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringMatching(/reopen/i));
    await user.click(button);
    expect(
      screen.queryByRole("dialog", { name: "Add new property" }),
    ).toBeNull();
    expect(screen.queryByTestId("value-edit-overlay")).toBeNull();

    const row = screen.getByText("Title").closest("tr")!;
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(row).toHaveAttribute("data-readonly", "true");
  });

  it.each([
    ["conflicting", "first", "second"],
    ["identical", "same", "same"],
  ])(
    "allows %s same-schema authoritative occurrences at a different destination",
    async (_caseName, firstValue, secondValue) => {
      const user = userEvent.setup();
      const info = {
        id,
        group: "XMP-dc",
        name: "Subject",
        writable: true,
        kind: { kind: "Text" as const },
        description: null,
      };
      _setSchemaTagNamesCache([info]);
      render(
        <DetailsPane
          photo={photo}
          occurrences={[
            {
              id: { ...target.occurrence_id, copy: 0 },
              schema_id: structuredClone(id),
              value: { kind: "Text", value: firstValue },
              tag_info: info,
              observed_selector: structuredClone(target.write_target),
              write_target: target.write_target,
            },
            {
              id: { ...target.occurrence_id, copy: 1 },
              schema_id: structuredClone(id),
              value: { kind: "Text", value: secondValue },
              tag_info: info,
              observed_selector: structuredClone(target.write_target),
              write_target: target.write_target,
            },
          ]}
          targetDraftPersistence={{ status: "ready" }}
          onRemoveMetadataTargets={vi.fn()}
          onDiscardTargetDraftBatch={vi.fn()}
        />,
      );

      await user.click(screen.getByTestId("details-pane-add-property-btn"));
      fireEvent.change(screen.getByTestId("new-property-key"), {
        target: { value: "Subject" },
      });
      await user.click(
        screen.getByTestId(`schema-option-${schemaDefinitionIdToken(id)}`),
      );

      expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
      expect(screen.getByTestId("new-property-next")).toBeEnabled();
    },
  );

  it("marks an unresolved authoritative schema as already existing", async () => {
    const user = userEvent.setup();
    const info = {
      id,
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Text" as const },
      description: null,
    };
    _setSchemaTagNamesCache([info]);
    render(
      <DetailsPane
        photo={photo}
        occurrences={[
          {
            id: target.occurrence_id,
            schema_id: structuredClone(id),
            value: { kind: "Text", value: "unresolved" },
            tag_info: null,
            observed_selector: null,
            write_target: null,
          },
        ]}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("details-pane-add-property-btn"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Subject" },
    });
    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(id)}`),
    );
    expect(
      screen.getByTestId("new-property-duplicate-warning"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("new-property-next")).toBeDisabled();
  });

  it("keeps absent index, index zero and same tag IDs in other tables separate", async () => {
    const user = userEvent.setup();
    const existingId: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
    };
    const indexZero: SchemaDefinitionId = {
      table: "Exif::Main",
      tag_id: "271",
      index: 0,
    };
    const otherTable: SchemaDefinitionId = {
      table: "Exif::Other",
      tag_id: "271",
    };
    const definitions = [
      {
        id: indexZero,
        group: "IFD0",
        name: "Collision",
        writable: true,
        kind: { kind: "Text" as const },
        description: null,
      },
      {
        id: otherTable,
        group: "IFD0",
        name: "Collision",
        writable: true,
        kind: { kind: "Text" as const },
        description: null,
      },
    ];
    _setSchemaTagNamesCache(definitions);
    render(
      <DetailsPane
        photo={photo}
        occurrences={[
          {
            id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              runtime_tag_id: "271",
              tag_id_scope: {
                table: "TestFixture::Runtime",
                tag_id: "271",
                index: null,
              },
              copy: 0,
            },
            schema_id: existingId,
            value: { kind: "Text", value: "existing" },
            tag_info: {
              id: existingId,
              group: "IFD0",
              name: "Make",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            observed_selector: structuredClone(target.write_target),
            write_target: {
              group1: "IFD0",
              group7: "ID-Test",
              tag_name: "Make",
            },
          },
        ]}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("details-pane-add-property-btn"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Collision" },
    });
    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(indexZero)}`),
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).toBeEnabled();

    await user.click(
      screen.getByTestId(
        `schema-option-${schemaDefinitionIdToken(otherTable)}`,
      ),
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).toBeEnabled();
  });

  it("does not schema-block a draft-only NewProperty at another destination", async () => {
    const user = userEvent.setup();
    const info = {
      id,
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Text" as const },
      description: null,
    };
    _setSchemaTagNamesCache([info]);
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(
      "target.jpg",
      {
        kind: "NewProperty",
        schema_id: structuredClone(id),
        write_target: {
          group1: "XMP-test",
          group7: "ID-Test",
          tag_name: "TestTag",
        },
      },
      { intent: "Set", value: { kind: "Text", value: "draft" } },
    );
    render(
      <DetailsPane
        photo={photo}
        occurrences={[]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("details-pane-add-property-btn"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Subject" },
    });
    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(id)}`),
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).toBeEnabled();
  });

  it("allows an exact schema whose target-owned drafts use other destinations", async () => {
    const user = userEvent.setup();
    const distinct = testId("XMP-dc:Title");
    _setSchemaTagNamesCache([
      {
        id,
        group: "XMP-dc",
        name: "Subject",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
      {
        id: distinct,
        group: "XMP-dc",
        name: "Title",
        writable: true,
        kind: { kind: "Text" },
        description: null,
      },
    ]);
    const store = new TargetDraftEditsStore();
    for (const copy of [0, 1]) {
      store.setMetadataTarget(
        "target.jpg",
        {
          ...target,
          occurrence_id: { ...target.occurrence_id, copy },
          write_target: {
            group1: "XMP-dc",
            group7: "ID-Test",
            tag_name: `Subject-${copy}`,
          },
        },
        { intent: "Set", value: { kind: "Text", value: `${copy}` } },
      );
    }
    render(
      <DetailsPane
        photo={photo}

        occurrences={[
          {
            id: target.occurrence_id,
            schema_id: structuredClone(id),
            value: { kind: "Text", value: "original" },
            tag_info: {
              id,
              group: "XMP-dc",
              name: "Subject",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            observed_selector: structuredClone(target.write_target),
            write_target: target.write_target,
          },
        ]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        targetDraftPersistence={{ status: "ready" }}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );
    await user.click(screen.getByTestId("details-pane-add-property-btn"));
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc" },
    });

    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(id)}`),
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).toBeEnabled();

    await user.click(
      screen.getByTestId(`schema-option-${schemaDefinitionIdToken(distinct)}`),
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
  });

  it("displays, edits and discards a reconciled draft through its exact target", async () => {
    const user = userEvent.setup();
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("target.jpg", target, {
      intent: "Set",
      value: { kind: "Text", value: "reconciled value" },
    });
    const onSetExistingOccurrenceDraft = vi.fn();
    const onDiscardTargetPropertyDraft = vi.fn();
    render(
      <DetailsPane
        photo={photo}

        occurrences={[
          {
            id: target.occurrence_id,
            schema_id: structuredClone(id),
            value: { kind: "Text", value: "original" },
            tag_info: {
              id,
              group: "XMP-dc",
              name: "Subject",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            observed_selector: structuredClone(target.write_target),
            write_target: target.write_target,
          },
        ]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        onDiscardTargetPropertyDraft={onDiscardTargetPropertyDraft}
      />,
    );

    expect(screen.getByText("reconciled value")).toBeInTheDocument();
    const row = screen.getByText("reconciled value").closest("tr")!;
    fireEvent.contextMenu(row);
    await user.click(screen.getByText("Edit…"));
    const input = screen.getByTestId("value-edit-input");
    expect(input).toHaveValue("reconciled value");
    await user.clear(input);
    await user.type(input, "updated");
    await user.click(screen.getByText("Save"));
    expect(onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      target,
      expect.objectContaining({
        intent: "Set",
        value: { kind: "Text", value: "updated" },
      }),
    );

    fireEvent.contextMenu(row);
    await user.click(screen.getByText("Discard edit"));
    expect(onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it("renders multiple missing same-schema targets as independent warning rows", () => {
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget("target.jpg", target, {
      intent: "Set",
      value: { kind: "Text", value: "first" },
    });
    store.setMetadataTarget(
      "target.jpg",
      {
        ...target,
        occurrence_id: { ...target.occurrence_id, copy: 1 },
        write_target: {
          group1: "XMP-dc",
          group7: "ID-Test",
          tag_name: "Subject-2",
        },
      },
      { intent: "Set", value: { kind: "Text", value: "second" } },
    );
    render(
      <DetailsPane
        photo={photo}
        occurrences={[]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("Additional target-aware edits"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Additional Metadata Occurrences"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(
      screen
        .getAllByTestId("details-metadata-row")
        .filter((row) => row.dataset.rowKind === "MissingOccurrenceDraftRow"),
    ).toHaveLength(2);
  });

  it("presents same-schema NewProperty drafts inline in separate destination groups", () => {
    const store = new TargetDraftEditsStore();
    for (const [group1, value] of [
      ["IFD0", "primary"],
      ["IFD1", "thumbnail"],
    ] as const) {
      store.setMetadataTarget(
        "target.jpg",
        {
          kind: "NewProperty",
          schema_id: structuredClone(id),
          write_target: {
            group1,
            group7: "ID-Test",
            tag_name: "Subject",
          },
        },
        { intent: "Set", value: { kind: "Text", value } },
      );
    }

    render(
      <DetailsPane
        photo={photo}
        occurrences={[]}
        targetDraftEdits={store.getMetadataFile("target.jpg")}
        onDiscardTargetPropertyDraft={vi.fn()}
      />,
    );

    expect(
      screen.queryByTestId("details-unresolved-target-list"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("details-section-IFD0")).toHaveTextContent(
      "primary",
    );
    expect(screen.getByTestId("details-section-IFD1")).toHaveTextContent(
      "thumbnail",
    );
    expect(
      screen
        .getAllByTestId("details-metadata-row")
        .filter((row) => row.dataset.rowKind === "NewPropertyRow"),
    ).toHaveLength(2);
  });
});

// ── Read-only schema handling in the row context menu ─────────────────────

describe("DetailsPane: read-only row context menu", () => {
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
  });

  function openRowContextMenu() {
    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("Make") !== null);
    expect(row).toBeDefined();
    fireEvent.contextMenu(row!);
  }

  it("renders no context menu at all for a read-only tag with no pending draft", async () => {
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetExistingOccurrenceDraft = vi.fn();

    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}

        occurrences={[
          {
            id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              runtime_tag_id: "Make",
              tag_id_scope: {
                table: "TestFixture::Runtime",
                tag_id: "Make",
                index: null,
              },
              copy: 0,
            },
            schema_id: testId("IFD0:Make"),
            value: { kind: "Text", value: "Canon" },
            tag_info: {
              id: testId("IFD0:Make"),
              group: "IFD0",
              name: "Make",
              writable: false,
              kind: { kind: "Text" },
              description: null,
            },
            observed_selector: {
              group1: "IFD0",
              group7: "ID-Test",
              tag_name: "Make",
            },
            write_target: {
              group1: "IFD0",
              group7: "ID-Test",
              tag_name: "Make",
            },
          },
        ]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
      />,
    );

    openRowContextMenu();

    // Wait a tick for useTagInfo + effect-driven close to settle.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
      expect(screen.queryByRole("button", { name: "View…" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Discard edit" })).toBeNull();
    });
    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
  });

  it("keeps Edit + enabled Remove for a writable existing tag", async () => {
    _setTagInfoCacheEntry("IFD0:Make", {
      group: "IFD0",
      name: "Make",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const onSetExistingOccurrenceDraft = vi.fn();
    const onRemoveMetadataTargets = vi.fn(() => true);

    render(
      <DetailsPane
        onRemoveMetadataTargets={onRemoveMetadataTargets}
        photo={photo}

        occurrences={[
          {
            id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              runtime_tag_id: "Make",
              tag_id_scope: {
                table: "TestFixture::Runtime",
                tag_id: "Make",
                index: null,
              },
              copy: 0,
            },
            schema_id: testId("IFD0:Make"),
            value: { kind: "Text", value: "Canon" },
            tag_info: {
              id: testId("IFD0:Make"),
              group: "IFD0",
              name: "Make",
              writable: true,
              kind: { kind: "Text" },
              description: null,
            },
            observed_selector: {
              group1: "IFD0",
              group7: "ID-Test",
              tag_name: "Make",
            },
            write_target: {
              group1: "IFD0",
              group7: "ID-Test",
              tag_name: "Make",
            },
          },
        ]}
        onSetExistingOccurrenceDraft={onSetExistingOccurrenceDraft}
      />,
    );

    openRowContextMenu();

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: "View…" })).toBeNull();

    const removeBtn = screen.getByRole("button", { name: "Remove" });
    expect(removeBtn).not.toBeDisabled();

    fireEvent.click(removeBtn);
    expect(onRemoveMetadataTargets).toHaveBeenCalledWith([
      {
        kind: "ExistingOccurrence",
        occurrence_id: {
          document: null,
          path: "JPEG-APP1-IFD0",
          runtime_tag_id: "Make",
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: "Make",
            index: null,
          },
          copy: 0,
        },
        schema_id: testId("IFD0:Make"),
        write_target: {
          group1: "IFD0",
          group7: "ID-Test",
          tag_name: "Make",
        },
      },
    ]);
    expect(onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
  });
});

describe("DetailsPane: GPS Combined-Editor context-menu and routing", () => {
  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();

    // Register all six GPS fields as writable
    const gpsFields = [
      { key: "GPS:GPSLatitude", kind: { kind: "Real" } },
      { key: "GPS:GPSLatitudeRef", kind: { kind: "Text" } },
      { key: "GPS:GPSLongitude", kind: { kind: "Real" } },
      { key: "GPS:GPSLongitudeRef", kind: { kind: "Text" } },
      { key: "GPS:GPSAltitude", kind: { kind: "Real" } },
      { key: "GPS:GPSAltitudeRef", kind: { kind: "Integer" } },
    ];
    for (const f of gpsFields) {
      _setTagInfoCacheEntry(f.key, {
        group: f.key.split(":")[0],
        name: f.key.split(":")[1],
        writable: true,
        kind: f.kind as any,
        description: null,
      });
    }

    // Register a non-GPS field
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
  });

  function openContextMenu(label: string) {
    const row = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText(label) !== null);
    expect(row).toBeDefined();
    fireEvent.contextMenu(row!);
  }

  function occurrencesFor(
    metadata: ReturnType<typeof mockMetadata>,
  ): MetadataOccurrence[] {
    return Object.values(metadata).map((entry, index) => {
      const { id, ...value } = entry;
      const friendly = testFriendlyName(id);
      const separator = friendly.indexOf(":");
      const group = friendly.slice(0, separator);
      const name = friendly.slice(separator + 1);
      return {
        id: {
          document: null,
          path: `JPEG-APP1-GPS-${id.tag_id}`,
          runtime_tag_id: id.tag_id,
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: id.tag_id,
            index: null,
          },
          copy: index,
        },
        schema_id: structuredClone(id),
        value,
        tag_info: {
          id,
          group,
          name,
          writable: true,
          kind: { kind: value.kind } as any,
          description: null,
        },
        observed_selector: {
          group1: group,
          group7: "ID-Test",
          tag_name: name,
        },
        write_target: { group1: group, group7: "ID-Test", tag_name: name },
      };
    });
  }

  function expectZeroSouthWestEdits(edits: MetadataTargetDraftEntry[]) {
    const editFor = (id: SchemaDefinitionId) =>
      edits.find(
        (entry) =>
          schemaDefinitionIdToken(entry.target.schema_id) ===
          schemaDefinitionIdToken(id),
      )?.edit;

    expect(editFor(testId("GPS:GPSLatitude"))).toMatchObject({
      intent: "Set",
      value: { kind: "Real", value: 0 },
    });
    expect(editFor(testId("GPS:GPSLatitudeRef"))).toMatchObject({
      intent: "Set",
      value: { kind: "Text", value: "S" },
    });
    expect(editFor(testId("GPS:GPSLongitude"))).toMatchObject({
      intent: "Set",
      value: { kind: "Real", value: 0 },
    });
    expect(editFor(testId("GPS:GPSLongitudeRef"))).toMatchObject({
      intent: "Set",
      value: { kind: "Text", value: "W" },
    });
  }

  it("shows both GPS edit actions while an unresolved non-GPS row stays read-only", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
      "GPS:GPSAltitude": 100,
      "GPS:GPSAltitudeRef": 0,
      "XMP-dc:Subject": "test",
    });
    const occurrences = occurrencesFor(metadata);
    const subject = occurrences.find(
      (occurrence) => occurrence.tag_info?.name === "Subject",
    )!;
    subject.tag_info = null;
    subject.write_target = null;
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrences}
        onRemoveMetadataTargets={vi.fn()}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    const gpsLabels = [
      "GPSLatitude",
      "GPSLatitudeRef",
      "GPSLongitude",
      "GPSLongitudeRef",
      "GPSAltitude",
      "GPSAltitudeRef",
    ];

    for (const label of gpsLabels) {
      openContextMenu(label);
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Edit GPS…" }),
      ).toBeInTheDocument();
      // Press Escape to dismiss context menu
      fireEvent.keyDown(document, { key: "Escape" });
    }

    // Check non-GPS field
    openContextMenu("Subject");
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit GPS…" })).toBeNull();
  });

  it("does not show ordinary mutation actions for a read-only GPS row", () => {
    const occurrences = occurrencesFromMetadataCollection(
      mockMetadata({ "GPS:GPSLatitude": 51.5 }),
    );
    const latitude = occurrences.find(
      (occurrence) => occurrence.tag_info?.name === "GPSLatitude",
    );
    expect(latitude).toBeDefined();
    latitude!.tag_info = {
      ...latitude!.tag_info!,
      writable: false,
    };

    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        photo={photo}
        occurrences={occurrences}
      />,
    );

    const row = screen
      .getAllByTestId("details-row")
      .find((candidate) => within(candidate).queryByText("GPSLatitude"));
    expect(row).toBeDefined();
    expect(row).toHaveAttribute("data-readonly", "true");
    fireEvent.contextMenu(row!);

    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit destination…" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    const editGps = screen.getByRole("button", { name: "Edit GPS…" });
    expect(editGps).toBeDisabled();
    expect(editGps.getAttribute("title")?.toLowerCase()).toMatch(
      /read-only|not writable/,
    );
    fireEvent.click(editGps);
    expect(screen.queryByTestId("gps-editor-lat-input")).toBeNull();
  });
  it("generic Edit uses semantic GPS latitude instead of the degree-formatted row", async () => {
    const metadata = mockMetadata({ "GPS:GPSLatitude": 53.983856 });
    render(
      <DetailsPane
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}

        occurrences={occurrencesFor(metadata)}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));

    // The row renders as `53.983856°`; the generic editor must receive the
    // semantic Real and therefore keep the unformatted numeric value.
    expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(53.983856);
  });

  it("clicking Edit GPS... opens GpsEditor on coordinate, ref, altitude, altitude ref fields", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
      "GPS:GPSAltitude": 100,
      "GPS:GPSAltitudeRef": 0,
    });
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}

        occurrences={occurrencesFor(metadata)}
        onRemoveMetadataTargets={vi.fn()}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    const testCases = [
      "GPSLatitude",
      "GPSLongitudeRef",
      "GPSAltitude",
      "GPSAltitudeRef",
    ];

    for (const label of testCases) {
      openContextMenu(label);
      fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));
      expect(
        await screen.findByTestId("gps-editor-overlay"),
      ).toBeInTheDocument();
      // Cancel the GpsEditor to clean up for next iteration
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
      });
    }
  });

  it("preserves authoritative S/W references when zero GPS is opened and saved unchanged", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 0,
      "GPS:GPSLatitudeRef": "S",
      "GPS:GPSLongitude": 0,
      "GPS:GPSLongitudeRef": "W",
    });
    const onRemoveMetadataTargets = vi.fn();
    const onApplyGpsTargetDraftBatch = vi.fn(
      (_entries: MetadataTargetDraftEntry[]) => true,
    );
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}

        occurrences={occurrencesFor(metadata)}
        onRemoveMetadataTargets={onRemoveMetadataTargets}
        onApplyGpsTargetDraftBatch={onApplyGpsTargetDraftBatch}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));

    expect(await screen.findByTestId("gps-editor-lat-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");

    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onRemoveMetadataTargets).not.toHaveBeenCalled();
    expect(onApplyGpsTargetDraftBatch).toHaveBeenCalledOnce();
    expectZeroSouthWestEdits(onApplyGpsTargetDraftBatch.mock.calls[0][0]);
  });

  it("preserves staged target-aware S/W references when zero GPS is opened and saved unchanged", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 0,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0,
      "GPS:GPSLongitudeRef": "E",
    });
    const occurrences = occurrencesFor(metadata);
    const planned = planGpsTargetDraftBatch(
      [
        {
          id: testId("GPS:GPSLatitudeRef"),
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "S" },
          },
        },
        {
          id: testId("GPS:GPSLongitudeRef"),
          edit: {
            intent: "Set",
            value: { kind: "Text", value: "W" },
          },
        },
      ],
      occurrences,
    );
    const targetDraftEdits: TargetDraftCollection = Object.fromEntries(
      planned.map(({ target, edit }) => [
        metadataDraftTargetSlotToken(target),
        { target, edit },
      ]),
    );
    const onRemoveMetadataTargets = vi.fn();
    const onApplyGpsTargetDraftBatch = vi.fn(
      (_entries: MetadataTargetDraftEntry[]) => true,
    );
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}

        occurrences={occurrences}
        targetDraftEdits={targetDraftEdits}
        onRemoveMetadataTargets={onRemoveMetadataTargets}
        onApplyGpsTargetDraftBatch={onApplyGpsTargetDraftBatch}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));

    expect(await screen.findByTestId("gps-editor-lat-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");

    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onRemoveMetadataTargets).not.toHaveBeenCalled();
    expect(onApplyGpsTargetDraftBatch).toHaveBeenCalledOnce();
    expectZeroSouthWestEdits(onApplyGpsTargetDraftBatch.mock.calls[0][0]);
  });

  it("keeps ordinary GPS row editing enabled while composite GPS capture is blocked", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "E",
    });
    const altitudeId = testId("GPS:GPSAltitude");
    const makeAltitudeTarget = (group1: string): MetadataDraftTarget => ({
      kind: "NewProperty",
      schema_id: structuredClone(altitudeId),
      write_target: { ...knownMetadataWriteTarget(altitudeId)!, group1 },
    });
    const first = makeAltitudeTarget("CustomGPS1");
    const second = makeAltitudeTarget("CustomGPS2");
    const targetDraftEdits: TargetDraftCollection = Object.fromEntries(
      [first, second].map((target) => [
        metadataDraftTargetSlotToken(target),
        {
          target,
          edit: {
            intent: "Set" as const,
            value: { kind: "Real" as const, value: 100 },
          },
        },
      ]),
    );
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(metadata)}
        targetDraftEdits={targetDraftEdits}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    openContextMenu("GPSLatitude");
    expect(screen.getByRole("button", { name: "Edit…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
    const rowEditGps = screen.getByRole("button", { name: "Edit GPS…" });
    expect(rowEditGps).toBeDisabled();
    expect(rowEditGps.getAttribute("title")).toContain(
      "Several staged New Property destinations",
    );
  });

  it("keeps ordinary GPS row actions available when the composite callback is absent", () => {
    const metadata = mockMetadata({ "GPS:GPSLatitude": 51.5 });
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(metadata)}
        onSetExistingOccurrenceDraft={vi.fn()}
        onRemoveMetadataTargets={vi.fn()}
      />,
    );

    openContextMenu("GPSLatitude");
    expect(screen.getByRole("button", { name: "Edit…" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
    const editGps = screen.getByRole("button", { name: "Edit GPS…" });
    expect(editGps).toBeDisabled();
    expect(editGps).toHaveAttribute(
      "title",
      "Target-aware GPS editing is unavailable in this view. Nothing was saved.",
    );
  });

  it("preserves a staged custom altitude destination through unchanged composite save", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "E",
    });
    const occurrences = occurrencesFor(metadata);
    const altitudeId = testId("GPS:GPSAltitude");
    const customTarget: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: structuredClone(altitudeId),
      write_target: {
        ...knownMetadataWriteTarget(altitudeId)!,
        group1: "CustomGPS",
      },
    };
    const altitudeEdit: MetadataDraftEdit = {
      intent: "Set",
      value: { kind: "Real", value: 100 },
    };
    const targetDraftEdits: TargetDraftCollection = {
      [metadataDraftTargetSlotToken(customTarget)]: {
        target: customTarget,
        edit: altitudeEdit,
      },
    };
    const onApplyGpsTargetDraftBatch = vi.fn(
      (_entries: MetadataTargetDraftEntry[]) => true,
    );
    render(
      <DetailsPane
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrences}
        targetDraftEdits={targetDraftEdits}
        onRemoveMetadataTargets={vi.fn()}
        onApplyGpsTargetDraftBatch={onApplyGpsTargetDraftBatch}
      />,
    );

    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));
    expect(await screen.findByTestId("gps-editor-alt-input")).toHaveValue(100);
    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onApplyGpsTargetDraftBatch).toHaveBeenCalledOnce();
    const altitudeEntries = onApplyGpsTargetDraftBatch.mock.calls[0][0].filter(
      (entry) => schemaDefinitionIdEquals(entry.target.schema_id, altitudeId),
    );
    expect(altitudeEntries).toHaveLength(1);
    expect(altitudeEntries[0].target.write_target.group1).toBe("CustomGPS");
    expect(
      onApplyGpsTargetDraftBatch.mock.calls[0][0].some(
        (entry) =>
          schemaDefinitionIdEquals(entry.target.schema_id, altitudeId) &&
          entry.target.write_target.group1 === "GPS",
      ),
    ).toBe(false);
  });

  it("keeps the composite editor open and saves nothing when a captured selector changes", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.12,
      "GPS:GPSLongitudeRef": "W",
    });
    const occurrences = occurrencesFor(metadata);
    const onApplyGpsTargetDraftBatch = vi.fn(() => true);
    const props = {
      onDiscardTargetDraftBatch: vi.fn(),
      photo,
      metadata,
      onRemoveMetadataTargets: vi.fn(),
      onApplyGpsTargetDraftBatch,
    };
    const rendered = render(
      <DetailsPane {...props} occurrences={occurrences} />,
    );
    openContextMenu("GPSLatitude");
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));
    expect(await screen.findByTestId("gps-editor-overlay")).toBeInTheDocument();

    const changed = occurrences.map((occurrence) =>
      occurrence.tag_info?.name === "GPSLongitude"
        ? {
            ...occurrence,
            write_target: {
              ...occurrence.write_target!,
              tag_name: "GPSLongitudeChanged",
            },
          }
        : occurrence,
    );
    rendered.rerender(<DetailsPane {...props} occurrences={changed} />);
    fireEvent.click(screen.getByTestId("gps-editor-save"));

    expect(onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(screen.getByTestId("gps-editor-overlay")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /captured GPS occurrence target no longer matches authoritative state.*nothing was saved/i,
    );
  });

  // Stateful wrapper harness to simulate real DetailsPane parent
  function DetailsPaneStateHarness({
    initialMetadata,
    photo,
  }: {
    initialMetadata: Record<string, unknown>;
    photo: PhotoInfo;
  }) {
    const [drafts, setDrafts] = useState<TargetDraftCollection>({});
    const metadata = mockMetadata(initialMetadata);
    const occurrences = occurrencesFor(metadata);

    return (
      <>
        <div data-testid="drafts-debug" style={{ display: "none" }}>
          {JSON.stringify(drafts)}
        </div>
        <DetailsPane
          photo={photo}

          occurrences={occurrences}
          targetDraftEdits={drafts}
          onRemoveMetadataTargets={vi.fn()}
          onApplyGpsTargetDraftBatch={(entries: MetadataTargetDraftEntry[]) => {
            const store = new TargetDraftEditsStore();
            if (Object.keys(drafts).length > 0) {
              store.resetMetadata({ [photo.relative_path]: drafts });
            }
            store.setMetadataBatch(photo.relative_path, entries);
            setDrafts(store.getMetadataFile(photo.relative_path) ?? {});
            return true;
          }}
          onDiscardTargetPropertyDraft={(target) => {
            const store = new TargetDraftEditsStore();
            store.resetMetadata({ [photo.relative_path]: drafts });
            store.deleteTarget(photo.relative_path, target);
            setDrafts(store.getMetadataFile(photo.relative_path) ?? {});
          }}
          onDiscardTargetDraftBatch={vi.fn()}
        />
      </>
    );
  }

  it("composite GPS save, rerender and reopen workflow", async () => {
    // Seed schema cache with string enum options
    _setTagInfoCacheEntry("GPS:GPSLatitudeRef", {
      group: "GPS",
      name: "GPSLatitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "N", label: "North" },
            { code: "S", label: "South" },
          ],
        },
      },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitudeRef", {
      group: "GPS",
      name: "GPSLongitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "E", label: "East" },
            { code: "W", label: "West" },
          ],
        },
      },
      description: null,
    });

    const user = userEvent.setup();

    render(
      <DetailsPaneStateHarness
        photo={photo}
        initialMetadata={{
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLatitudeRef": "N",
          "GPS:GPSLongitude": 0.12,
          "GPS:GPSLongitudeRef": "E",
        }}
      />,
    );

    // Open "Edit GPS..."
    openContextMenu("GPSLatitude");
    await user.click(screen.getByRole("button", { name: "Edit GPS…" }));

    // Change latitude ref to S
    const latRefSelect = await screen.findByTestId("gps-editor-lat-ref");
    await user.selectOptions(latRefSelect, "S");

    // Change longitude ref to W
    const lonRefSelect = screen.getByTestId("gps-editor-lon-ref");
    await user.selectOptions(lonRefSelect, "W");

    // Save the composite editor
    await user.click(screen.getByTestId("gps-editor-save"));

    // Confirm that the dialog closed
    await waitFor(() => {
      expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
    });

    // Confirm the pending row displays use schema labels
    const rowLatRef = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("GPSLatitudeRef") !== null);
    expect(rowLatRef).toBeDefined();
    expect(within(rowLatRef!).getByText("South")).toBeInTheDocument();

    const rowLonRef = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("GPSLongitudeRef") !== null);
    expect(rowLonRef).toBeDefined();
    expect(within(rowLonRef!).getByText("West")).toBeInTheDocument();

    // Reopen "Edit GPS..." without applying drafts
    openContextMenu("GPSLatitude");
    await user.click(screen.getByRole("button", { name: "Edit GPS…" }));

    // Assert latitude select is S and longitude select is W, and not N/E
    expect(await screen.findByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");

    // Cancel the editor
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    // Inspect the emitted drafts and confirm
    const draftsJson = JSON.parse(
      screen.getByTestId("drafts-debug").textContent || "{}",
    );
    const draftFor = (id: SchemaDefinitionId) =>
      Object.values(draftsJson).find(
        (entry: any) =>
          schemaDefinitionIdToken(entry.target.schema_id) ===
          schemaDefinitionIdToken(id),
      ) as any;
    expect(draftFor(testId("GPS:GPSLatitudeRef"))).toMatchObject({
      target: { schema_id: testId("GPS:GPSLatitudeRef") },
      edit: {
        value: { kind: "Text", value: "S" },
        intent: "Set",
        display: "South",
      },
    });
    expect(draftFor(testId("GPS:GPSLongitudeRef"))).toMatchObject({
      target: { schema_id: testId("GPS:GPSLongitudeRef") },
      edit: {
        value: { kind: "Text", value: "W" },
        intent: "Set",
        display: "West",
      },
    });
  });

  it("individual enum edit followed by composite GPS edit", async () => {
    // Seed schema cache with string enum options for LatitudeRef
    _setTagInfoCacheEntry("GPS:GPSLatitudeRef", {
      group: "GPS",
      name: "GPSLatitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "N", label: "North" },
            { code: "S", label: "South" },
          ],
        },
      },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitudeRef", {
      group: "GPS",
      name: "GPSLongitudeRef",
      writable: true,
      kind: {
        kind: "Enum",
        data: {
          repr: "String",
          options: [
            { code: "E", label: "East" },
            { code: "W", label: "West" },
          ],
        },
      },
      description: null,
    });

    const user = userEvent.setup();

    render(
      <DetailsPaneStateHarness
        photo={photo}
        initialMetadata={{
          "GPS:GPSLatitude": 51.5,
          "GPS:GPSLatitudeRef": "N",
          "GPS:GPSLongitude": 0.12,
          "GPS:GPSLongitudeRef": "E",
        }}
      />,
    );

    // Open the ordinary individual "Edit..." action for GPSLatitudeRef
    const rowLatRef = screen
      .getAllByTestId("details-row")
      .find((r) => within(r).queryByText("GPSLatitudeRef") !== null);
    expect(rowLatRef).toBeDefined();
    fireEvent.contextMenu(rowLatRef!);
    await user.click(screen.getByRole("button", { name: "Edit…" }));

    // Select South
    const select = (await screen.findByTestId(
      "enum-editor-select",
    )) as HTMLSelectElement;
    await user.selectOptions(select, "S");

    // Save individual EnumEditor
    await user.click(screen.getByTestId("enum-editor-save"));

    // Confirm the dialog closed
    await waitFor(() => {
      expect(screen.queryByTestId("enum-editor-overlay")).toBeNull();
    });

    // Confirm resulting draft is semantic Text("S") and display "South"
    const draftsJson = JSON.parse(
      screen.getByTestId("drafts-debug").textContent || "{}",
    );
    const latitudeRefDraft = Object.values(draftsJson).find(
      (entry: any) =>
        schemaDefinitionIdToken(entry.target.schema_id) ===
        schemaDefinitionIdToken(testId("GPS:GPSLatitudeRef")),
    );
    expect(latitudeRefDraft).toMatchObject({
      target: { schema_id: testId("GPS:GPSLatitudeRef") },
      edit: {
        value: { kind: "Text", value: "S" },
        intent: "Set",
        display: "South",
      },
    });

    // Open "Edit GPS..." for any member of that GPS group (e.g. GPSLatitude)
    openContextMenu("GPSLatitude");
    await user.click(screen.getByRole("button", { name: "Edit GPS…" }));

    // Assert that the composite latitude-ref select opens as S
    expect(await screen.findByTestId("gps-editor-lat-ref")).toHaveValue("S");

    // Cancel the editor
    await user.click(screen.getByRole("button", { name: "Cancel" }));
  });
});

describe("DetailsPane: Group context menu", () => {
  let askMock = vi.fn();

  beforeEach(() => {
    cleanup();
    _clearTagInfoCache();
    askMock = vi.fn(() => Promise.resolve(true));
    vi.doMock("@tauri-apps/plugin-dialog", () => ({ ask: askMock }));
  });

  afterEach(() => {
    vi.doUnmock("@tauri-apps/plugin-dialog");
  });

  const photo = makePhoto({
    relative_path: "p.jpg",
    filename: "p.jpg",
    date_modified: 0,
    date_created: 0,
  });

  it("Shows remove count for writable fields only", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSVersionID", {
      group: "GPS",
      name: "GPSVersionID",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });

    const onSetBatch = vi.fn();
    const onDiscardBatch = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}

        occurrences={mockOccurrences(
          {
            "GPS:GPSLatitude": 51.5,
            "GPS:GPSLongitude": -0.1,
            "GPS:GPSVersionID": "2.2.0.0",
          },
          ["GPS:GPSVersionID"],
        )}
        onRemoveMetadataTargets={onSetBatch}
        onDiscardTargetDraftBatch={onDiscardBatch}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    expect(
      screen.queryByRole("button", {
        name: "Remove all 3 writable GPS fields…",
      }),
    ).toBeNull();
  });

  it("Does not show remove when all fields read-only and no edits", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSVersionID", {
      group: "GPS",
      name: "GPSVersionID",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}

        occurrences={mockOccurrences({ "GPS:GPSVersionID": "2.2.0.0" }, [
          "GPS:GPSVersionID",
        ])}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    // Wait a tick for effects to close the menu
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
      expect(screen.queryByRole("button", { name: /Discard/ })).toBeNull();
    });
  });

  it("Remove action stages deletes via batch", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const removeTargets = vi.fn(() => true);
    const occurrences = mockOccurrences({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLongitude": -0.1,
    });

    render(
      <FreshDetailsPane
        photo={photo}
        occurrences={occurrences}
        onRemoveMetadataTargets={removeTargets}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    const removeBtn = await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });

    expect(askMock.mock.calls[0][0]).toContain(
      "2 existing fields will receive pending delete edits.",
    );
    expect(askMock.mock.calls[0][0]).not.toContain("delete edits only");

    expect(removeTargets).toHaveBeenCalledWith(
      occurrences.map((occurrence) => ({
        kind: "ExistingOccurrence",
        occurrence_id: occurrence.id,
        schema_id: occurrence.schema_id,
        write_target: occurrence.write_target!,
      })),
    );
  });

  it("uses exact supplemental Remove and Discard actions for multiple occurrences", async () => {
    vi.resetModules();
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");
    const id = testId("XMP-dc:Title");
    const first = mockOccurrences({ "XMP-dc:Title": "first" })[0];
    const second = structuredClone(first);
    second.id.path = "TEST-XMP-dc-duplicate";
    second.id.copy = 1;
    second.value = { kind: "Text", value: "second" };
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget(
      "p.jpg",
      {
        kind: "ExistingOccurrence",
        occurrence_id: first.id,
        schema_id: id,
        write_target: first.write_target!,
      },
      { intent: "Set", value: { kind: "Text", value: "edited" } },
    );

    render(
      <FreshDetailsPane
        photo={photo}
        occurrences={[first, second]}
        targetDraftEdits={targetStore.getMetadataFile("p.jpg")}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    expect(
      screen.queryByText("Additional Metadata Occurrences"),
    ).not.toBeInTheDocument();
    const rows = screen
      .getAllByTestId("details-row")
      .filter((row) => row.dataset.rowKind === "ExistingOccurrenceRow");
    expect(rows).toHaveLength(2);
    const edited = rows.find((row) =>
      row.hasAttribute("data-has-exact-draft"),
    )!;
    fireEvent.contextMenu(edited);
    expect(
      await screen.findByRole("button", { name: "Remove" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard edit" }),
    ).toBeInTheDocument();
  });

  it("routes staged NewProperty removal only through the target-aware group callback", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");
    const id = testId("XMP-dc:Title");
    _clearTagInfoCache();
    _setTagInfoCacheEntry(id, {
      id,
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const targetStore = new TargetDraftEditsStore();
    const target = {
      kind: "NewProperty" as const,
      schema_id: id,
      write_target: {
        group1: "XMP-test",
        group7: "ID-Test",
        tag_name: "TestTag",
      },
    };
    targetStore.setMetadataTarget("p.jpg", target, {
      intent: "Set",
      value: { kind: "Text", value: "new" },
    });
    const remove = vi.fn(() => true);
    const discardTargets = vi.fn();

    render(
      <FreshDetailsPane
        photo={photo}

        occurrences={[]}
        targetDraftEdits={targetStore.getMetadataFile("p.jpg")}
        onRemoveMetadataTargets={remove}
        onDiscardTargetDraftBatch={discardTargets}
      />,
    );
    const section = screen.getByTestId("details-section-XMP-test");
    fireEvent.contextMenu(
      within(section).getByRole("heading", { name: "XMP-test", level: 3 }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove 1 writable XMP-test field…",
      }),
    );
    await waitFor(() => expect(askMock).toHaveBeenCalledTimes(1));
    expect(askMock.mock.calls[0][0]).toContain(
      "1 staged new-property addition will be cancelled.",
    );
    expect(askMock.mock.calls[0][0]).not.toContain("delete edits only");
    expect(remove).toHaveBeenCalledWith([target]);
    expect(discardTargets).not.toHaveBeenCalled();
  });

  it("hides group Remove for an already staged exact Delete while retaining Discard", async () => {
    vi.resetModules();
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");
    const id = testId("XMP-dc:Title");
    const occurrences = mockOccurrences({ "XMP-dc:Title": "current" });
    const exactTarget = {
      kind: "ExistingOccurrence" as const,
      occurrence_id: occurrences[0].id,
      schema_id: id,
      write_target: occurrences[0].write_target!,
    };
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget("p.jpg", exactTarget, {
      intent: "Delete",
      value: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}

        occurrences={occurrences}
        targetDraftEdits={targetStore.getMetadataFile("p.jpg")}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    const section = screen.getByTestId("details-section-XMP-dc");
    fireEvent.contextMenu(
      within(section).getByRole("heading", { name: "XMP-dc", level: 3 }),
    );
    expect(
      await screen.findByRole("button", { name: "Discard 1 XMP-dc edit…" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull();
  });

  it("uses the complete group when the details search filters out some rows", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    _setTagInfoCacheEntry("GPS:GPSLatitude", {
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });
    _setTagInfoCacheEntry("GPS:GPSLongitude", {
      group: "GPS",
      name: "GPSLongitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    });

    const removeTargets = vi.fn(() => true);
    const occurrences = mockOccurrences({
      "GPS:GPSLatitude": 51.5,
      "GPS:GPSLongitude": -0.1,
    });

    render(
      <FreshDetailsPane
        photo={photo}
        occurrences={occurrences}
        onRemoveMetadataTargets={removeTargets}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    // Filter to only match GPSLatitude
    const searchInput = screen.getByTestId("details-search-input");
    await userEvent.type(searchInput, "Latitude");

    // Verify GPSLongitude is no longer visible
    expect(screen.queryByText("Longitude")).toBeNull();
    expect(screen.getByText("Latitude")).toBeInTheDocument();

    const section = screen.getByTestId("details-section-GPS");
    const heading = within(section).getByRole("heading", {
      name: "GPS",
      level: 3,
    });
    fireEvent.contextMenu(heading);

    // Expecting: "Remove all 2 writable GPS fields…" because search filter
    // does not reduce the group action scope.
    const removeBtn = await screen.findByRole("button", {
      name: "Remove all 2 writable GPS fields…",
    });
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(askMock).toHaveBeenCalledTimes(1);
    });

    expect(removeTargets).toHaveBeenCalledWith(
      occurrences.map((occurrence) => ({
        kind: "ExistingOccurrence",
        occurrence_id: occurrence.id,
        schema_id: occurrence.schema_id,
        write_target: occurrence.write_target!,
      })),
    );
  });

  it("handles singular/plural labels and formatting correctly (e.g. File group)", async () => {
    vi.resetModules();
    const { _setTagInfoCacheEntry, _clearTagInfoCache } =
      await import("./tagInfoTestHelpers");
    const { DetailsPane: FreshDetailsPane } =
      await import("../components/DetailsPane");

    _clearTagInfoCache();
    // Register exactly one tag in File group (e.g. File:FileSize)
    _setTagInfoCacheEntry("File:FileSize", {
      group: "File",
      name: "FileSize",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });

    render(
      <FreshDetailsPane
        photo={photo}

        occurrences={mockOccurrences({ "File:FileSize": "1 MB" })}
        onRemoveMetadataTargets={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-File");
    const heading = within(section).getByRole("heading", {
      name: "File",
      level: 3,
    });

    // Check singular remove label
    fireEvent.contextMenu(heading);
    await screen.findByRole("button", {
      name: "Remove 1 writable File field…",
    });
  });
});

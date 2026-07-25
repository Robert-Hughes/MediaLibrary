/**
 * Coverage for the FileList "Reverse Geocode…" context-menu entry.
 *
 * The pre-click overwrite warning has moved into
 * GeocodeProgressDialog's awaiting-confirm panel (see
 * geocode-progress-dialog.test.tsx). This file now only pins the
 * context-menu entry's local responsibilities:
 *
 *   - the entry is always shown when one or more files are selected;
 *   - count suffix follows the same shape as Generate AI Description;
 *   - clicking the entry invokes `onGeocode` with the selected paths
 *     directly — no `ask()` round-trip.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FileList } from "../components/FileList";
import { ThumbnailStore, ImageMetadataOccurrencesStore } from "../types";
import type { MetadataTargetDraftEntry } from "../types";
import {
  mockMetadata,
  mockTargetDraftsByFile,
  newPropertyTargetDraft,
} from "./factories";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

async function getAskMock() {
  const mod = await import("@tauri-apps/plugin-dialog");
  return (mod as unknown as { ask: ReturnType<typeof vi.fn> }).ask;
}

interface SetupOptions {
  fileCount?: number;
  metadataByPath?: Record<string, Parameters<typeof mockMetadata>[0]>;
  targetDraftEntriesByPath?: Record<string, MetadataTargetDraftEntry[]>;
  onGeocode?: (paths: string[]) => void;
}

function setup(opts: SetupOptions = {}) {
  const n = opts.fileCount ?? 5;
  const files = Array.from({ length: n }, (_, i) => ({
    relative_path: `${i}.jpg`,
    filename: `${i}.jpg`,
    date_modified: null,
    date_created: null,
  }));

  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataOccurrencesStore();
  for (const p of files) {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  }
  if (opts.metadataByPath) {
    for (const [path, meta] of Object.entries(opts.metadataByPath)) {
      imageMetadata.set(
        path,
        occurrencesFromMetadataCollection(mockMetadata(meta)),
      );
    }
  }

  const onGeocode = vi.fn(opts.onGeocode ?? (() => {}));

  render(
    <FileList
      targetDraftEdits={mockTargetDraftsByFile(
        opts.targetDraftEntriesByPath ?? {},
      )}
      files={files}
      thumbnails={thumbnails}
      imageMetadataOccurrences={imageMetadata}
      visibleColumns={[]}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedIndex={null}
      onSelect={() => {}}
      onShowInExplorer={() => {}}
      onVisibilityChange={() => {}}
      onFileOpen={() => {}}
      onApplyEdits={() => {}}
      onDiscardAllEdits={() => {}}
      onGenerateAiDescription={() => {}}
      onGeocode={onGeocode}
    />,
  );

  return { onGeocode };
}

function rows() {
  return screen.getAllByTestId("file-row");
}

describe("FileList: Reverse Geocode context-menu entry", () => {
  beforeEach(async () => {
    cleanup();
    const ask = await getAskMock();
    ask.mockClear();
  });

  it("entry is visible when a single file is selected, even with no GPS", async () => {
    setup();
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", {
      name: "Reverse Geocode…",
    });
    expect(entry).toBeInTheDocument();
  });

  it("entry label includes count and noun for multi-select", async () => {
    setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[4], { ctrlKey: true });
    fireEvent.contextMenu(rows()[4]);
    const entry = await screen.findByRole("button", {
      name: "Reverse Geocode… (3 files)",
    });
    expect(entry).toBeInTheDocument();
  });

  it("entry is hidden when onGeocode is not wired", async () => {
    const n = 3;
    const files = Array.from({ length: n }, (_, i) => ({
      relative_path: `${i}.jpg`,
      filename: `${i}.jpg`,
      date_modified: null,
      date_created: null,
    }));
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataOccurrencesStore();
    for (const p of files) {
      thumbnails.add(p.relative_path);
      imageMetadata.add(p.relative_path);
    }
    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        imageMetadataOccurrences={imageMetadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onFileOpen={() => {}}
      />,
    );
    fireEvent.click(rows()[0]);
    fireEvent.contextMenu(rows()[0]);
    await screen.findByRole("button", { name: /^View/ });
    expect(
      screen.queryByRole("button", { name: /^Reverse Geocode/ }),
    ).toBeNull();
  });

  it("invokes onGeocode with the selected paths without prompting (no location data)", async () => {
    const { onGeocode } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", {
      name: /^Reverse Geocode/,
    });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledTimes(1);
    expect(onGeocode).toHaveBeenCalledWith(["1.jpg", "2.jpg"]);
  });

  it("invokes onGeocode directly even when every selected file carries location data", async () => {
    // The overwrite warning now lives in the dialog — the menu entry
    // fires the callback unconditionally.
    const { onGeocode } = setup({
      metadataByPath: {
        "1.jpg": { "XMP-fileshop:City": "London" },
        "2.jpg": { "IPTC:Country-PrimaryLocationName": "France" },
      },
    });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", {
      name: /^Reverse Geocode/,
    });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledWith(["1.jpg", "2.jpg"]);
  });

  it("invokes onGeocode directly when only some selected files carry location data", async () => {
    const { onGeocode } = setup({
      metadataByPath: { "2.jpg": { "XMP-iptcCore:Location": "Big Ben" } },
    });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const entry = await screen.findByRole("button", {
      name: /^Reverse Geocode/,
    });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledWith(["1.jpg", "2.jpg", "3.jpg"]);
  });

  it("invokes onGeocode directly when a draft-only location tag is present", async () => {
    const { onGeocode } = setup({
      targetDraftEntriesByPath: {
        "0.jpg": [
          newPropertyTargetDraft("XMP-fileshop:State", {
            intent: "Set",
            value: { kind: "Text", value: "Bavaria" },
          }),
        ],
      },
    });
    fireEvent.click(rows()[0]);
    fireEvent.contextMenu(rows()[0]);
    const entry = await screen.findByRole("button", {
      name: "Reverse Geocode…",
    });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledWith(["0.jpg"]);
  });
});

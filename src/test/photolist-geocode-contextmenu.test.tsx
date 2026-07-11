/**
 * Coverage for the PhotoList "Reverse Geocode…" context-menu entry.
 *
 * The pre-click overwrite warning has moved into
 * GeocodeProgressDialog's awaiting-confirm panel (see
 * geocode-progress-dialog.test.tsx). This file now only pins the
 * context-menu entry's local responsibilities:
 *
 *   - the entry is always shown when one or more photos are selected;
 *   - count suffix follows the same shape as Generate AI Description;
 *   - clicking the entry invokes `onGeocode` with the selected paths
 *     directly — no `ask()` round-trip.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { MetadataDraftEdit } from "../types";
import { mockDraftsByFile, mockMetadata } from "./factories";

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
  photoCount?: number;
  metadataByPath?: Record<string, Record<string, any>>;
  draftEditsByPath?: Record<string, Record<string, MetadataDraftEdit>>;
  onGeocode?: (paths: string[]) => void;
}

function setup(opts: SetupOptions = {}) {
  const n = opts.photoCount ?? 5;
  const photos = Array.from({ length: n }, (_, i) => ({
    relative_path: `${i}.jpg`,
    filename: `${i}.jpg`,
    date_modified: null,
    date_created: null,
  }));

  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataStore();
  for (const p of photos) {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  }
  if (opts.metadataByPath) {
    for (const [path, meta] of Object.entries(opts.metadataByPath)) {
      imageMetadata.set(path, mockMetadata(meta));
    }
  }

  const onGeocode = vi.fn(opts.onGeocode ?? (() => {}));

  render(
    <PhotoList
      photos={photos}
      thumbnails={thumbnails}
      imageMetadata={imageMetadata}
      visibleColumns={[]}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedIndex={null}
      onSelect={() => {}}
      onShowInExplorer={() => {}}
      onVisibilityChange={() => {}}
      onPhotoOpen={() => {}}
      onApplyEdits={() => {}}
      onDiscardAllEdits={() => {}}
      onGenerateAiDescription={() => {}}
      onGeocode={onGeocode}
      draftEdits={mockDraftsByFile(opts.draftEditsByPath ?? {})}
    />,
  );

  return { onGeocode };
}

function rows() {
  return screen.getAllByTestId("photo-row");
}

describe("PhotoList: Reverse Geocode context-menu entry", () => {
  beforeEach(async () => {
    cleanup();
    const ask = await getAskMock();
    ask.mockClear();
  });

  it("entry is visible when a single photo is selected, even with no GPS", async () => {
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
      name: "Reverse Geocode… (3 photos)",
    });
    expect(entry).toBeInTheDocument();
  });

  it("entry is hidden when onGeocode is not wired", async () => {
    const n = 3;
    const photos = Array.from({ length: n }, (_, i) => ({
      relative_path: `${i}.jpg`,
      filename: `${i}.jpg`,
      date_modified: null,
      date_created: null,
    }));
    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataStore();
    for (const p of photos) {
      thumbnails.add(p.relative_path);
      imageMetadata.add(p.relative_path);
    }
    render(
      <PhotoList
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
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

  it("invokes onGeocode directly even when every selected photo carries location data", async () => {
    // The overwrite warning now lives in the dialog — the menu entry
    // fires the callback unconditionally.
    const { onGeocode } = setup({
      metadataByPath: {
        "1.jpg": { "XMP-photoshop:City": "London" },
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

  it("invokes onGeocode directly when only some selected photos carry location data", async () => {
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
      draftEditsByPath: {
        "0.jpg": {
          "XMP-photoshop:State": {
            intent: "Set",
            value: { kind: "Text", value: "Bavaria" },
          },
        },
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

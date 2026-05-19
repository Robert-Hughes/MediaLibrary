/**
 * Coverage for the PhotoList "Reverse Geocode…" context-menu entry
 * (multi-select overwrite-warning flow).
 *
 * Pinned by docs/REVERSE_GEOCODE_PLAN.md §5 (PhotoList multi-select)
 * and §5 "Context menu visibility". Verifies:
 *
 *   - the entry is always shown when one or more photos are selected,
 *     regardless of whether the selected photos have GPS — `no_gps`
 *     surfaces as a per-image failure in the done panel instead;
 *   - count suffix follows the same shape as Generate AI Description
 *     ("Reverse Geocode… (3 photos)" for multi, "Reverse Geocode…"
 *     for a single selection);
 *   - clicking with **no** §1 location data anywhere in the selection
 *     invokes `onGeocode` directly (no `ask`);
 *   - any §1 target tag in metadata triggers the overwrite warning;
 *   - same for §1 keys in the legacy draft map;
 *   - the warning copy adapts to "all selected", "some selected", and
 *     "single selected" (plan §5 three-message contract);
 *   - dismissing the warning suppresses the callback.
 *
 * `ask` and `invoke` are mocked at module scope.
 */
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";
import type { Variant } from "../types";

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
  /** Per-path metadata to seed before render. */
  metadataByPath?: Record<string, Record<string, Variant>>;
  /** Per-path draft edits to seed (legacy string-map shape). */
  draftEditsByPath?: Record<string, Record<string, string | null>>;
  /** Override the onGeocode handler so tests can inspect call args. */
  onGeocode?: (paths: string[]) => void;
}

/**
 * Render PhotoList with a stable set of synthetic photos and the props
 * the geocode entry depends on. The shared mocks above keep `ask`'s
 * default resolution truthy; individual tests can override per-call.
 */
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
  // Seed metadata after `add()` so the store transitions out of
  // "loading" to a real object — the entry's existing-tag scan checks
  // for object-typed metadata only.
  if (opts.metadataByPath) {
    for (const [path, meta] of Object.entries(opts.metadataByPath)) {
      imageMetadata.set(path, meta);
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
      draftEdits={opts.draftEditsByPath ?? {}}
    />,
  );

  return { onGeocode };
}

function rows() {
  return screen.getAllByTestId("photo-row");
}

describe("PhotoList: Reverse Geocode context-menu entry (plan §5)", () => {
  beforeEach(async () => {
    cleanup();
    const ask = await getAskMock();
    ask.mockClear();
    ask.mockResolvedValue(true);
  });

  it("entry is visible when a single photo is selected, even with no GPS", async () => {
    // Plan §5 'Context menu visibility': always visible. No GPS-presence
    // filter — the no_gps photo will surface in the done panel.
    setup();
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", { name: "Reverse Geocode…" });
    expect(entry).toBeInTheDocument();
  });

  it("entry label includes count and noun for multi-select", async () => {
    // Mirrors the Generate AI Description label shape so the two
    // entries read consistently in the menu.
    setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[4], { ctrlKey: true });
    fireEvent.contextMenu(rows()[4]);
    const entry = await screen.findByRole("button", { name: "Reverse Geocode… (3 photos)" });
    expect(entry).toBeInTheDocument();
  });

  it("entry is hidden when onGeocode is not wired", async () => {
    // Without a handler the entry would be a no-op; suppress it
    // entirely so the user isn't confused by a dead menu item.
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
    // Some other entry should still be present so we know the menu opened.
    await screen.findByRole("button", { name: /^View/ });
    expect(screen.queryByRole("button", { name: /^Reverse Geocode/ })).toBeNull();
  });

  it("invokes onGeocode immediately when no §1 location data is present", async () => {
    // No location tags in metadata or drafts → no confirm step → the
    // callback receives all selected paths in original order.
    const { onGeocode } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", { name: /^Reverse Geocode/ });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledTimes(1);
    expect(onGeocode).toHaveBeenCalledWith(["1.jpg", "2.jpg"]);
  });

  it("'all selected have existing' message fires when every selected photo carries §1 metadata", async () => {
    // Plan §5: when the entire selection has existing location data the
    // copy reads "All N selected photos already have…". Verifies the
    // metadata path of the existing-tag scan.
    const { onGeocode } = setup({
      metadataByPath: {
        "1.jpg": { "XMP-photoshop:City": "London" },
        "2.jpg": { "IPTC:Country-PrimaryLocationName": "France" },
      },
    });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const entry = await screen.findByRole("button", { name: /^Reverse Geocode/ });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).toHaveBeenCalledTimes(1);
    const msg = ask.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/^All 2 selected photos already have location data/);
    expect(msg).toMatch(/will be cleared/i);
    expect(ask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ title: "Overwrite location data?", kind: "warning" }),
    );
    expect(onGeocode).toHaveBeenCalledWith(["1.jpg", "2.jpg"]);
  });

  it("'some selected have existing' message fires for a partial overlap", async () => {
    // Plan §5 partial-overlap branch — only one of three selected
    // photos has existing data, so the wording must read "X of N".
    setup({
      metadataByPath: {
        "2.jpg": { "XMP-iptcCore:Location": "Big Ben" },
      },
    });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const entry = await screen.findByRole("button", { name: /^Reverse Geocode/ });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).toHaveBeenCalledTimes(1);
    const msg = ask.mock.calls[0]?.[0] as string;
    // Grammar conjugates by `existing.length` after the
    // `buildOverwriteWarning` refactor — X==1 says "has", X>1 says
    // "have". Pre-refactor copy always said "have".
    expect(msg).toMatch(/^1 of 3 selected photos already has location data/);
    expect(msg).toMatch(/for those photos/);
  });

  it("single-selection message fires when only one photo is selected and has existing data", async () => {
    // Plan §5 single-photo branch — distinct copy ("This photo already
    // has…") so the prompt reads naturally when N === 1.
    setup({
      metadataByPath: {
        "0.jpg": { "IPTC:City": "Paris" },
      },
    });
    fireEvent.click(rows()[0]);
    fireEvent.contextMenu(rows()[0]);
    const entry = await screen.findByRole("button", { name: "Reverse Geocode…" });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).toHaveBeenCalledTimes(1);
    const msg = ask.mock.calls[0]?.[0] as string;
    expect(msg).toMatch(/^This photo already has location data/);
    expect(msg).toMatch(/will be cleared/i);
  });

  it("draft-only §1 tag also triggers the overwrite warning", async () => {
    // The existing-tag scan unions metadata with the per-file draft map.
    // A draft-only edit must still trigger the warning, otherwise
    // running the flow would clobber an in-progress manual fix.
    setup({
      draftEditsByPath: {
        "0.jpg": { "XMP-photoshop:State": "Bavaria" },
      },
    });
    fireEvent.click(rows()[0]);
    fireEvent.contextMenu(rows()[0]);
    const entry = await screen.findByRole("button", { name: "Reverse Geocode…" });
    await userEvent.click(entry);
    const ask = await getAskMock();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("dismissing the warning suppresses the callback", async () => {
    // Confirms the user's bail-out path: ask resolves false → onGeocode
    // is not called.
    const ask = await getAskMock();
    ask.mockResolvedValueOnce(false);
    const { onGeocode } = setup({
      metadataByPath: { "0.jpg": { "IPTC:Sub-location": "Tower" } },
    });
    fireEvent.click(rows()[0]);
    fireEvent.contextMenu(rows()[0]);
    const entry = await screen.findByRole("button", { name: "Reverse Geocode…" });
    await userEvent.click(entry);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onGeocode).not.toHaveBeenCalled();
  });
});

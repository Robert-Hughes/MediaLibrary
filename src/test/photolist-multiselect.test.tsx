import { useState } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore, ImageMetadataStore } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));

function makePhotos(n: number) {
  const photos = [];
  for (let i = 0; i < n; i++) {
    photos.push({
      relative_path: `${i}.jpg`,
      filename: `${i}.jpg`,
      date_modified: null,
      date_created: null,
    });
  }
  return photos;
}

function setup(props: Partial<React.ComponentProps<typeof PhotoList>> = {}) {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataStore();
  const photos = props.photos ?? makePhotos(5);
  for (const p of photos) {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  }
  const onSelect = vi.fn();
  const onShowInExplorer = vi.fn();
  const onPhotoOpen = vi.fn();
  const onApplyEdits = vi.fn();
  const onDiscardAllEdits = vi.fn();
  const onGenerateAiDescription = vi.fn();

  render(
    <PhotoList
      photos={photos}
      thumbnails={thumbnails}
      imageMetadata={imageMetadata}
      visibleColumns={[]}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedIndex={null}
      onSelect={onSelect}
      onShowInExplorer={onShowInExplorer}
      onVisibilityChange={vi.fn()}
      onPhotoOpen={onPhotoOpen}
      onApplyEdits={onApplyEdits}
      onDiscardAllEdits={onDiscardAllEdits}
      onGenerateAiDescription={onGenerateAiDescription}
      {...props}
    />,
  );
  return { onSelect, onShowInExplorer, onPhotoOpen, onApplyEdits, onDiscardAllEdits, onGenerateAiDescription };
}

function rows() {
  return screen.getAllByTestId("photo-row");
}

/**
 * Like setup() but keeps `selectedIndex` in real component state so chained
 * keyboard gestures see the updated anchor between events.  The plain setup()
 * leaves selectedIndex frozen, which is fine for single-key tests but breaks
 * any flow that reads cur after a previous keydown moved it.
 */
function setupStateful(opts: { initialIndex?: number | null; photoCount?: number; onSelectionCountChange?: (n: number) => void } = {}) {
  const thumbnails = new ThumbnailStore();
  const imageMetadata = new ImageMetadataStore();
  const photos = makePhotos(opts.photoCount ?? 5);
  for (const p of photos) {
    thumbnails.add(p.relative_path);
    imageMetadata.add(p.relative_path);
  }
  const onPhotoOpen = vi.fn();
  function Wrapper() {
    const [selectedIndex, setSelectedIndex] = useState<number | null>(opts.initialIndex ?? null);
    return (
      <PhotoList
        photos={photos}
        thumbnails={thumbnails}
        imageMetadata={imageMetadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedIndex={selectedIndex}
        onSelect={setSelectedIndex}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onPhotoOpen={onPhotoOpen}
        onSelectionCountChange={opts.onSelectionCountChange}
      />
    );
  }
  render(<Wrapper />);
  return { onPhotoOpen };
}

describe("PhotoList multi-select", () => {
  beforeEach(() => cleanup());

  it("plain click selects a single row", async () => {
    setup();
    await userEvent.click(rows()[2]);
    const selected = document.querySelectorAll(".photo-row--selected");
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute("data-index")).toBe("2");
  });

  it("ctrl-click toggles additional rows into the selection", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(rows()[1]);
    await user.keyboard("{Control>}");
    await user.click(rows()[3]);
    await user.keyboard("{/Control}");
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "3"]);
  });

  it("ctrl-click on an already-selected row removes it from the selection", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(rows()[1]);
    await user.keyboard("{Control>}");
    await user.click(rows()[2]);
    await user.click(rows()[2]);
    await user.keyboard("{/Control}");
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1"]);
  });

  it("shift-click selects a contiguous range from the anchor", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(rows()[1]);
    await user.keyboard("{Shift>}");
    await user.click(rows()[4]);
    await user.keyboard("{/Shift}");
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2", "3", "4"]);
  });

  it("right-click on an unselected row collapses the selection to that row", () => {
    setup();
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"));
    expect(selected).toEqual(["3"]);
  });

  it("right-click on an already-selected row preserves the selection", () => {
    setup();
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["0", "2"]);
  });
});

describe("PhotoList context menu (multi-select)", () => {
  beforeEach(() => cleanup());

  it("View action targets the first selected photo only", async () => {
    const { onPhotoOpen } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const view = await screen.findByRole("button", { name: /^View/ });
    await userEvent.click(view);
    expect(onPhotoOpen).toHaveBeenCalledWith(1);
  });

  it("Show in File Explorer targets the first selected photo only", async () => {
    const { onShowInExplorer } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const btn = await screen.findByRole("button", { name: /^Show in File Explorer/ });
    await userEvent.click(btn);
    expect(onShowInExplorer).toHaveBeenCalledWith(1);
  });

  it("Copy Path passes the single selected path to onCopyPaths", async () => {
    const onCopyPaths = vi.fn();
    setup({ onCopyPaths });
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    const btn = await screen.findByRole("button", { name: "Copy Path" });
    await userEvent.click(btn);
    expect(onCopyPaths).toHaveBeenCalledTimes(1);
    expect(onCopyPaths).toHaveBeenCalledWith(["2.jpg"]);
  });

  it("Copy Paths labels with count and passes all selected paths", async () => {
    const onCopyPaths = vi.fn();
    setup({ onCopyPaths });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[4], { ctrlKey: true });
    fireEvent.contextMenu(rows()[4]);
    const btn = await screen.findByRole("button", { name: "Copy Paths (3)" });
    await userEvent.click(btn);
    expect(onCopyPaths).toHaveBeenCalledWith(["1.jpg", "2.jpg", "4.jpg"]);
  });

  it("Copy Path is hidden when onCopyPaths prop is not provided", async () => {
    setup();
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    await screen.findByRole("button", { name: /^View/ });
    expect(screen.queryByRole("button", { name: /Copy Path/ })).toBeNull();
  });

  it("Generate AI Description passes all selected paths in a single call", async () => {
    const { onGenerateAiDescription } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[4], { ctrlKey: true });
    fireEvent.contextMenu(rows()[4]);
    const btn = await screen.findByRole("button", { name: /Generate AI Description/ });
    await userEvent.click(btn);
    expect(onGenerateAiDescription).toHaveBeenCalledTimes(1);
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["1.jpg", "2.jpg", "4.jpg"]);
  });

  it("Generate AI Description is shown for single selection too", async () => {
    const { onGenerateAiDescription } = setup();
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    const btn = await screen.findByRole("button", { name: "Generate AI Description…" });
    await userEvent.click(btn);
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["2.jpg"]);
  });

  it("Generate AI Description invokes onGenerateAiDescription directly even when some selected photos already have a description (warning lives in dialog now)", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();

    const thumbnails = new ThumbnailStore();
    const imageMetadata = new ImageMetadataStore();
    const photos = makePhotos(5);
    for (const p of photos) {
      thumbnails.add(p.relative_path);
      imageMetadata.add(p.relative_path);
    }
    imageMetadata.set("2.jpg", { "XMP-mlib:AIDescription": "old text" });
    const onGenerateAiDescription = vi.fn();
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
        onVisibilityChange={vi.fn()}
        onPhotoOpen={() => {}}
        onGenerateAiDescription={onGenerateAiDescription}
      />,
    );

    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    await userEvent.click(await screen.findByRole("button", { name: /Generate AI Description/ }));

    expect(ask).not.toHaveBeenCalled();
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["1.jpg", "2.jpg", "3.jpg"]);
  });

  it("Generate AI Description fires for draft-only AIDescription without prompting", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();

    const onGenerateAiDescription = vi.fn();
    const draftEdits = { "1.jpg": { "XMP-mlib:AIDescription": "draft text" } };
    setup({ draftEdits, onGenerateAiDescription });
    fireEvent.click(rows()[1]);
    fireEvent.contextMenu(rows()[1]);
    await userEvent.click(await screen.findByRole("button", { name: /Generate AI Description/ }));

    expect(ask).not.toHaveBeenCalled();
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["1.jpg"]);
  });

  it("Generate AI Description fires immediately when no selected photo has a description", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();
    const { onGenerateAiDescription } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    await userEvent.click(await screen.findByRole("button", { name: /Generate AI Description/ }));
    expect(ask).not.toHaveBeenCalled();
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["1.jpg", "2.jpg"]);
  });

  it("Apply edits passes the array of edited selected paths", async () => {
    const draftEdits = {
      "1.jpg": { "IFD0:Make": "Canon" },
      "3.jpg": { "IFD0:Model": "R5" },
    };
    const { onApplyEdits } = setup({ draftEdits });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const btn = await screen.findByRole("button", { name: /Apply edits/ });
    await userEvent.click(btn);
    // Wait for the async confirm() promise to resolve.
    await new Promise((r) => setTimeout(r, 0));
    expect(onApplyEdits).toHaveBeenCalledTimes(1);
    expect(onApplyEdits).toHaveBeenCalledWith(["1.jpg", "3.jpg"]);
  });

  it("Discard all edits passes the array of edited selected paths", async () => {
    const draftEdits = {
      "0.jpg": { "IFD0:Make": "Canon" },
      "2.jpg": { "IFD0:Model": "R5" },
    };
    const { onDiscardAllEdits } = setup({ draftEdits });
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const btn = await screen.findByRole("button", { name: /Discard all edits/ });
    await userEvent.click(btn);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDiscardAllEdits).toHaveBeenCalledTimes(1);
    expect(onDiscardAllEdits).toHaveBeenCalledWith(["0.jpg", "2.jpg"]);
  });

  it("hides Apply/Discard items when no selected photos have edits", () => {
    setup({ draftEdits: {} });
    fireEvent.click(rows()[1]);
    fireEvent.contextMenu(rows()[1]);
    expect(screen.queryByRole("button", { name: /Apply edits/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Discard all edits/ })).toBeNull();
  });
});

describe("PhotoList keyboard navigation", () => {
  beforeEach(() => cleanup());

  it("ArrowDown selects the next row", async () => {
    const { onSelect } = setup({ selectedIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it("ArrowUp selects the previous row", async () => {
    const { onSelect } = setup({ selectedIndex: 3 });
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });

  it("ArrowDown from no selection lands on the first row", async () => {
    const { onSelect } = setup({ selectedIndex: null });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("ArrowDown clamps at the last row", async () => {
    const { onSelect } = setup({ selectedIndex: 4 });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith(4);
  });

  it("Home jumps to the first row, End jumps to the last", async () => {
    const { onSelect } = setup({ selectedIndex: 2 });
    fireEvent.keyDown(document, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith(0);
    fireEvent.keyDown(document, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith(4);
  });

  it("Ctrl+A selects every row", async () => {
    setup({ selectedIndex: 0 });
    fireEvent.keyDown(document, { key: "a", ctrlKey: true });
    const selected = document.querySelectorAll(".photo-row--selected");
    expect(selected.length).toBe(5);
  });

  it("ignores arrow keys when focus is in a text input", async () => {
    const { onSelect } = setup({ selectedIndex: 1 });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("PageDown jumps roughly one page down and clamps at the last row", () => {
    const { onSelect } = setup({ selectedIndex: 1 });
    // jsdom reports clientHeight=0, so the handler falls back to a 10-row page step.
    fireEvent.keyDown(document, { key: "PageDown" });
    expect(onSelect).toHaveBeenLastCalledWith(4);
  });

  it("PageUp jumps roughly one page up and clamps at the first row", () => {
    const { onSelect } = setup({ selectedIndex: 4 });
    fireEvent.keyDown(document, { key: "PageUp" });
    expect(onSelect).toHaveBeenLastCalledWith(0);
  });

  it("Enter opens the currently selected photo", () => {
    const { onPhotoOpen } = setup({ selectedIndex: 2 });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onPhotoOpen).toHaveBeenCalledWith(2);
  });

  it("Enter is a no-op when nothing is selected", () => {
    const { onPhotoOpen } = setup({ selectedIndex: null });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onPhotoOpen).not.toHaveBeenCalled();
  });

  it("Shift+ArrowDown extends the selection from the anchor", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2", "3"]);
  });

  it("Shift+ArrowUp shrinks the range when reversing direction", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowUp", shiftKey: true });
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2"]);
  });

  it("Shift+End selects from the anchor to the last row", () => {
    setupStateful({ initialIndex: 2 });
    fireEvent.keyDown(document, { key: "End", shiftKey: true });
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["2", "3", "4"]);
  });

  it("Ctrl+ArrowDown adds the next row to the selection without clearing", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2", "3"]);
  });

  it("Ctrl+ArrowDown updates the anchor so a later Shift extends from the new row", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    // Anchor is now at 3; Shift+ArrowDown should produce the [3..4] range,
    // collapsing the previous additive picks.
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    const selected = Array.from(document.querySelectorAll(".photo-row--selected"))
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["3", "4"]);
  });

  it("notifies onSelectionCountChange when the selection grows or shrinks", () => {
    const onSelectionCountChange = vi.fn();
    setupStateful({ initialIndex: null, onSelectionCountChange });
    onSelectionCountChange.mockClear();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelectionCountChange).toHaveBeenLastCalledWith(1);
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    expect(onSelectionCountChange).toHaveBeenLastCalledWith(2);
    fireEvent.keyDown(document, { key: "a", ctrlKey: true });
    expect(onSelectionCountChange).toHaveBeenLastCalledWith(5);
  });
});

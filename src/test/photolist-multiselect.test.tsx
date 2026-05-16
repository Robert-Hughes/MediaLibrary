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
});

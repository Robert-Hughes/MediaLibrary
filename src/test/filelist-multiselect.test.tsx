import { createRef, useState } from "react";
import {
  mockMetadata,
  mockTargetDraftsByFile,
  newPropertyTargetDraft,
  testId,
} from "./factories";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { FileList, type FileListSelectionHandle } from "../components/FileList";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "../types";
import type { FileInfo, MetadataDraftEdit } from "../types";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));

function makeFiles(n: number) {
  const files = [];
  for (let i = 0; i < n; i++) {
    files.push({
      relative_path: `${i}.jpg`,
      filename: `${i}.jpg`,
      media_kind: "image" as const,
      date_modified: null,
      date_created: null,
    });
  }
  return files;
}

type SetupProps = Partial<React.ComponentProps<typeof FileList>>;

function setup(props: SetupProps = {}) {
  const { targetDraftEdits = {}, ...componentProps } = props;
  const thumbnails = new ThumbnailStore();
  const fileMetadata = new FileMetadataOccurrencesStore();
  const files = props.files ?? makeFiles(5);
  for (const p of files) {
    thumbnails.add(p.relative_path);
    fileMetadata.add(p.relative_path);
  }
  const onSelect = vi.fn();
  const onShowInExplorer = vi.fn();
  const onFileOpen = vi.fn();
  const onApplyEdits = vi.fn();
  const onDiscardAllEdits = vi.fn();
  const onGenerateAiDescription = vi.fn();

  render(
    <FileList
      targetDraftEdits={targetDraftEdits}
      files={files}
      thumbnails={thumbnails}
      fileMetadataOccurrences={fileMetadata}
      visibleColumns={[]}
      sortConfig={{ primary: null, secondary: null }}
      onSortChange={() => {}}
      selectedPath={null}
      onSelect={onSelect}
      onShowInExplorer={onShowInExplorer}
      onVisibilityChange={vi.fn()}
      onFileOpen={onFileOpen}
      onApplyEdits={onApplyEdits}
      onDiscardAllEdits={onDiscardAllEdits}
      onGenerateAiDescription={onGenerateAiDescription}
      {...componentProps}
    />,
  );
  return {
    onSelect,
    onShowInExplorer,
    onFileOpen,
    onApplyEdits,
    onDiscardAllEdits,
    onGenerateAiDescription,
  };
}

function rows() {
  return screen.getAllByTestId("file-row");
}

function textDraft(value: string): MetadataDraftEdit {
  return { intent: "Set", value: { kind: "Text", value } };
}

/**
 * Like setup() but keeps `selectedIndex` in real component state so chained
 * keyboard gestures see the updated anchor between events.  The plain setup()
 * leaves selectedIndex frozen, which is fine for single-key tests but breaks
 * any flow that reads cur after a previous keydown moved it.
 */
function setupStateful(
  opts: {
    initialIndex?: number | null;
    fileCount?: number;
    onSelectionCountChange?: (n: number) => void;
  } = {},
) {
  const thumbnails = new ThumbnailStore();
  const fileMetadata = new FileMetadataOccurrencesStore();
  const files = makeFiles(opts.fileCount ?? 5);
  for (const p of files) {
    thumbnails.add(p.relative_path);
    fileMetadata.add(p.relative_path);
  }
  const onFileOpen = vi.fn();
  function Wrapper() {
    const [selectedPath, setSelectedPath] = useState<string | null>(
      typeof opts.initialIndex === "number"
        ? (files[opts.initialIndex]?.relative_path ?? null)
        : null,
    );
    return (
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={selectedPath}
        onSelect={setSelectedPath}
        onShowInExplorer={vi.fn()}
        onVisibilityChange={vi.fn()}
        onFileOpen={onFileOpen}
        onSelectionCountChange={opts.onSelectionCountChange}
      />
    );
  }
  render(<Wrapper />);
  return { onFileOpen };
}

describe("FileList multi-select", () => {
  beforeEach(() => cleanup());

  it("plain click selects a single row", async () => {
    setup();
    await userEvent.click(rows()[2]);
    const selected = document.querySelectorAll(".file-row--selected");
    expect(selected.length).toBe(1);
    expect(selected[0].getAttribute("data-index")).toBe("2");
  });

  it("Alt-click leaves row selection unchanged for text copying", () => {
    const { onSelect } = setup();

    fireEvent.click(rows()[2], { altKey: true });

    expect(onSelect).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".file-row--selected")).toHaveLength(0);
  });

  it("Alt-double-click does not open the file", () => {
    const { onFileOpen } = setup();

    fireEvent.doubleClick(rows()[2], { altKey: true });

    expect(onFileOpen).not.toHaveBeenCalled();
  });

  it("ctrl-click toggles additional rows into the selection", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(rows()[1]);
    await user.keyboard("{Control>}");
    await user.click(rows()[3]);
    await user.keyboard("{/Control}");
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
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
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
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
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2", "3", "4"]);
  });

  it("right-click on an unselected row collapses the selection to that row", () => {
    setup();
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    ).map((el) => el.getAttribute("data-index"));
    expect(selected).toEqual(["3"]);
  });

  it("right-click on an already-selected row preserves the selection", () => {
    setup();
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["0", "2"]);
  });
});

describe("FileList context menu (multi-select)", () => {
  beforeEach(() => cleanup());

  it("View action targets the first selected file only", async () => {
    const { onFileOpen } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const view = await screen.findByRole("button", { name: /^View/ });
    await userEvent.click(view);
    expect(onFileOpen).toHaveBeenCalledWith("1.jpg");
  });

  it("Show in File Explorer targets the first selected file only", async () => {
    const { onShowInExplorer } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    const btn = await screen.findByRole("button", {
      name: /^Show in File Explorer/,
    });
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

  it("Show on Map passes all selected paths and closes the context menu", async () => {
    const onShowOnMap = vi.fn();
    setup({ onShowOnMap });
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);

    await userEvent.click(
      await screen.findByRole("button", {
        name: "Show on Map (2 files)",
      }),
    );

    expect(onShowOnMap).toHaveBeenCalledWith(["1.jpg", "3.jpg"]);
    expect(screen.queryByTestId("context-menu")).toBeNull();
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
    const btn = await screen.findByRole("button", {
      name: /Generate AI Description/,
    });
    await userEvent.click(btn);
    expect(onGenerateAiDescription).toHaveBeenCalledTimes(1);
    expect(onGenerateAiDescription).toHaveBeenCalledWith([
      "1.jpg",
      "2.jpg",
      "4.jpg",
    ]);
  });

  it("Generate AI Description is shown for single selection too", async () => {
    const { onGenerateAiDescription } = setup();
    fireEvent.click(rows()[2]);
    fireEvent.contextMenu(rows()[2]);
    const btn = await screen.findByRole("button", {
      name: "Generate AI Description…",
    });
    await userEvent.click(btn);
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["2.jpg"]);
  });

  it("Generate AI Description invokes onGenerateAiDescription directly even when some selected files already have a description (warning lives in dialog now)", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();

    const thumbnails = new ThumbnailStore();
    const fileMetadata = new FileMetadataOccurrencesStore();
    const files = makeFiles(5);
    for (const p of files) {
      thumbnails.add(p.relative_path);
      fileMetadata.add(p.relative_path);
    }
    fileMetadata.set(
      "2.jpg",
      occurrencesFromMetadataCollection(
        mockMetadata({ "XMP-mlib:AIDescription": "old text" }),
      ),
    );
    const onGenerateAiDescription = vi.fn();
    render(
      <FileList
        targetDraftEdits={{}}
        files={files}
        thumbnails={thumbnails}
        fileMetadataOccurrences={fileMetadata}
        visibleColumns={[]}
        sortConfig={{ primary: null, secondary: null }}
        onSortChange={() => {}}
        selectedPath={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={vi.fn()}
        onFileOpen={() => {}}
        onGenerateAiDescription={onGenerateAiDescription}
      />,
    );

    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.click(rows()[3], { ctrlKey: true });
    fireEvent.contextMenu(rows()[3]);
    await userEvent.click(
      await screen.findByRole("button", { name: /Generate AI Description/ }),
    );

    expect(ask).not.toHaveBeenCalled();
    expect(onGenerateAiDescription).toHaveBeenCalledWith([
      "1.jpg",
      "2.jpg",
      "3.jpg",
    ]);
  });

  it("Generate AI Description fires for draft-only AIDescription without prompting", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();

    const onGenerateAiDescription = vi.fn();
    const targetDraftEdits = mockTargetDraftsByFile({
      "1.jpg": [
        newPropertyTargetDraft(
          "XMP-mlib:AIDescription",
          textDraft("draft text"),
        ),
      ],
    });
    setup({ targetDraftEdits, onGenerateAiDescription });
    fireEvent.click(rows()[1]);
    fireEvent.contextMenu(rows()[1]);
    await userEvent.click(
      await screen.findByRole("button", { name: /Generate AI Description/ }),
    );

    expect(ask).not.toHaveBeenCalled();
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["1.jpg"]);
  });

  it("Generate AI Description fires immediately when no selected file has a description", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();
    const { onGenerateAiDescription } = setup();
    fireEvent.click(rows()[1]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    await userEvent.click(
      await screen.findByRole("button", { name: /Generate AI Description/ }),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(onGenerateAiDescription).toHaveBeenCalledWith(["1.jpg", "2.jpg"]);
  });

  it("hides AI Describe for an audio-only selection", async () => {
    const files = makeFiles(1).map((file) => ({
      ...file,
      relative_path: "track.flac",
      filename: "track.flac",
      media_kind: "audio" as const,
    }));
    setup({ files });

    fireEvent.contextMenu(rows()[0]);

    expect(
      screen.queryByRole("button", { name: /Generate AI Description/ }),
    ).not.toBeInTheDocument();
  });

  it("hides AI Describe for a video-only selection", async () => {
    const files = makeFiles(1).map((file) => ({
      ...file,
      relative_path: "clip.mp4",
      filename: "clip.mp4",
      media_kind: "video" as const,
    }));
    setup({ files });

    fireEvent.contextMenu(rows()[0]);

    expect(
      screen.queryByRole("button", { name: /Generate AI Description/ }),
    ).not.toBeInTheDocument();
  });

  it("disables AI Describe for a mixed-media selection", async () => {
    const files: FileInfo[] = makeFiles(2);
    files[1] = {
      ...files[1],
      relative_path: "track.flac",
      filename: "track.flac",
      media_kind: "audio",
    };
    const { onGenerateAiDescription } = setup({ files });

    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[1], { ctrlKey: true });
    fireEvent.contextMenu(rows()[1]);

    const button = await screen.findByRole("button", {
      name: /Generate AI Description/,
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "AI Describe requires an image-only selection",
    );
    await userEvent.click(button);
    expect(onGenerateAiDescription).not.toHaveBeenCalled();
  });
  it("Apply edits passes the array of edited selected paths", async () => {
    const targetDraftEdits = mockTargetDraftsByFile({
      "1.jpg": [newPropertyTargetDraft("IFD0:Make", textDraft("Canon"))],
      "3.jpg": [newPropertyTargetDraft("IFD0:Model", textDraft("R5"))],
    });
    const { onApplyEdits } = setup({ targetDraftEdits });
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

  it("counts multiple same-schema exact targets independently in badges and prompts", async () => {
    const { ask } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(ask).mockClear();
    const schema = testId("IFD0:Make");
    const targetDraftEdits = mockTargetDraftsByFile({
      "1.jpg": [
        newPropertyTargetDraft("IFD0:Make", textDraft("Canon")),
        {
          target: {
            kind: "ExistingOccurrence",
            occurrence_id: {
              document: null,
              path: "JPEG-APP1-IFD0",
              runtime_tag_id: schema.tag_id,
              tag_id_scope: {
                table: "TestFixture::Runtime",
                tag_id: schema.tag_id,
                index: null,
              },
              copy: 0,
            },
            schema_id: schema,
            write_target: {
              group1: "IFD0",
              group7: "ID-Test",
              tag_name: "Make",
            },
          },
          edit: textDraft("Nikon"),
        },
      ],
    });
    const { onApplyEdits } = setup({ targetDraftEdits });

    const row = rows()[1];
    expect(within(row).getByText("2 draft edits")).toBeInTheDocument();
    fireEvent.click(row);
    fireEvent.contextMenu(row);
    await userEvent.click(
      await screen.findByRole("button", { name: /Apply edits/ }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("Apply 2 edits"),
      expect.anything(),
    );
    expect(onApplyEdits).toHaveBeenCalledWith(["1.jpg"]);
  });

  it("Discard all edits passes the array of edited selected paths", async () => {
    const targetDraftEdits = mockTargetDraftsByFile({
      "0.jpg": [newPropertyTargetDraft("IFD0:Make", textDraft("Canon"))],
      "2.jpg": [newPropertyTargetDraft("IFD0:Model", textDraft("R5"))],
    });
    const { onDiscardAllEdits } = setup({ targetDraftEdits });
    fireEvent.click(rows()[0]);
    fireEvent.click(rows()[2], { ctrlKey: true });
    fireEvent.contextMenu(rows()[2]);
    const btn = await screen.findByRole("button", {
      name: /Discard all edits/,
    });
    await userEvent.click(btn);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDiscardAllEdits).toHaveBeenCalledTimes(1);
    expect(onDiscardAllEdits).toHaveBeenCalledWith(["0.jpg", "2.jpg"]);
  });

  it("hides Apply/Discard items when no selected files have edits", () => {
    setup({ targetDraftEdits: {} });
    fireEvent.click(rows()[1]);
    fireEvent.contextMenu(rows()[1]);
    expect(screen.queryByRole("button", { name: /Apply edits/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Discard all edits/ }),
    ).toBeNull();
  });
});

describe("FileList keyboard navigation", () => {
  beforeEach(() => cleanup());

  it("ArrowDown selects the next row", async () => {
    const { onSelect } = setup({ selectedPath: "1.jpg" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("2.jpg");
  });

  it("ArrowUp selects the previous row", async () => {
    const { onSelect } = setup({ selectedPath: "3.jpg" });
    fireEvent.keyDown(document, { key: "ArrowUp" });
    expect(onSelect).toHaveBeenLastCalledWith("2.jpg");
  });

  it("ArrowDown from no selection lands on the first row", async () => {
    const { onSelect } = setup({ selectedPath: null });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("0.jpg");
  });

  it("ArrowDown clamps at the last row", async () => {
    const { onSelect } = setup({ selectedPath: "4.jpg" });
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(onSelect).toHaveBeenLastCalledWith("4.jpg");
  });

  it("Home jumps to the first row, End jumps to the last", async () => {
    const { onSelect } = setup({ selectedPath: "2.jpg" });
    fireEvent.keyDown(document, { key: "Home" });
    expect(onSelect).toHaveBeenLastCalledWith("0.jpg");
    fireEvent.keyDown(document, { key: "End" });
    expect(onSelect).toHaveBeenLastCalledWith("4.jpg");
  });

  it("Ctrl+A selects every row", async () => {
    setup({ selectedPath: "0.jpg" });
    fireEvent.keyDown(document, { key: "a", ctrlKey: true });
    const selected = document.querySelectorAll(".file-row--selected");
    expect(selected.length).toBe(5);
  });

  it("toggles all rows through the shared selection handle", () => {
    const selectionRef = createRef<FileListSelectionHandle>();
    const onSelectionCountChange = vi.fn();
    const { onSelect } = setup({
      ref: selectionRef,
      onSelectionCountChange,
    });
    onSelectionCountChange.mockClear();

    act(() => selectionRef.current?.toggleAllSelection());
    expect(document.querySelectorAll(".file-row--selected")).toHaveLength(5);
    expect(onSelectionCountChange).toHaveBeenLastCalledWith(5);

    act(() => selectionRef.current?.toggleAllSelection());
    expect(document.querySelectorAll(".file-row--selected")).toHaveLength(0);
    expect(onSelectionCountChange).toHaveBeenLastCalledWith(0);
    expect(onSelect).toHaveBeenLastCalledWith(null);
  });

  it("ignores arrow keys when focus is in a text input", async () => {
    const { onSelect } = setup({ selectedPath: "1.jpg" });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(onSelect).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("PageDown jumps roughly one page down and clamps at the last row", () => {
    const { onSelect } = setup({ selectedPath: "1.jpg" });
    // jsdom reports clientHeight=0, so the handler falls back to a 10-row page step.
    fireEvent.keyDown(document, { key: "PageDown" });
    expect(onSelect).toHaveBeenLastCalledWith("4.jpg");
  });

  it("PageUp jumps roughly one page up and clamps at the first row", () => {
    const { onSelect } = setup({ selectedPath: "4.jpg" });
    fireEvent.keyDown(document, { key: "PageUp" });
    expect(onSelect).toHaveBeenLastCalledWith("0.jpg");
  });

  it("Enter opens the currently selected file", () => {
    const { onFileOpen } = setup({ selectedPath: "2.jpg" });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onFileOpen).toHaveBeenCalledWith("2.jpg");
  });

  it("Enter is a no-op when nothing is selected", () => {
    const { onFileOpen } = setup({ selectedPath: null });
    fireEvent.keyDown(document, { key: "Enter" });
    expect(onFileOpen).not.toHaveBeenCalled();
  });

  it("Shift+ArrowDown extends the selection from the anchor", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2", "3"]);
  });

  it("Shift+ArrowUp shrinks the range when reversing direction", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(document, { key: "ArrowUp", shiftKey: true });
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["1", "2"]);
  });

  it("Shift+End selects from the anchor to the last row", () => {
    setupStateful({ initialIndex: 2 });
    fireEvent.keyDown(document, { key: "End", shiftKey: true });
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
      .map((el) => el.getAttribute("data-index"))
      .sort();
    expect(selected).toEqual(["2", "3", "4"]);
  });

  it("Ctrl+ArrowDown adds the next row to the selection without clearing", () => {
    setupStateful({ initialIndex: 1 });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    fireEvent.keyDown(document, { key: "ArrowDown", ctrlKey: true });
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
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
    const selected = Array.from(
      document.querySelectorAll(".file-row--selected"),
    )
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

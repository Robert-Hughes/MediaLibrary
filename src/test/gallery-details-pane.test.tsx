/**
 * Integration tests for the gallery details pane feature.
 *
 * Tests simulate real UI interaction: clicking toggle buttons, pressing
 * keyboard shortcuts, and verifying that the DOM updates accordingly.
 */
import {
  render,
  screen,
  within,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { GalleryView } from "../components/GalleryView";
import { ask } from "@tauri-apps/plugin-dialog";

import { FileMetadataOccurrencesStore } from "../types";
import {
  makeFiles,
  mockMetadata,
  mockTargetDraftsByFile,
  newPropertyTargetDraft,
} from "./factories";
import type { FileInfo } from "../types";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));
// ── Test helpers ─────────────────────────────────────────────────────────────

const PHOTOS: FileInfo[] = makeFiles([
  "2024/a.jpg",
  "2024/b.jpg",
  "2024/c.jpg",
]);
const fakeLoadMedia = async (_path: string) => "data:image/jpeg;base64,FAKE";

/** Render the GalleryView with defaults suitable for integration testing. */
async function renderGallery(
  overrides: Partial<ComponentProps<typeof GalleryView>> = {},
) {
  const onRemoveMetadataTargets = vi.fn();
  const onDiscardTargetDraftBatch = vi.fn();

  const props = {
    files: PHOTOS,
    currentIndex: 0,
    folderPath: "/files",
    onClose: vi.fn(),
    onNavigate: vi.fn(),
    loadMedia: fakeLoadMedia,
    fileMetadataOccurrences: new FileMetadataOccurrencesStore(),
    ...overrides,
  };

  const result = render(
    <GalleryView
      {...props}
      onRemoveMetadataTargets={
        overrides.onRemoveMetadataTargets ?? onRemoveMetadataTargets
      }
      onDiscardTargetDraftBatch={
        overrides.onDiscardTargetDraftBatch ?? onDiscardTargetDraftBatch
      }
    />,
  );
  await screen.findByTestId("gallery-image");
  return result;
}

// ── Integration tests ────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  _clearTagInfoCache();
  const commonTags = [
    "IFD0:Make",
    "IFD0:Model",
    "ExifIFD:ISO",
    "XMP-dc:Subject",
    "IFD0:Orientation",
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

describe("Gallery details pane toggle", () => {
  it("details pane is hidden by default", async () => {
    await renderGallery();
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("shows details pane when toggle button is clicked", async () => {
    await renderGallery();

    const toggle = screen.getByTestId("gallery-info-toggle");
    expect(toggle).toBeInTheDocument();

    await userEvent.click(toggle);
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();
  });

  it("hides details pane when toggle button is clicked again", async () => {
    await renderGallery();

    const toggle = screen.getByTestId("gallery-info-toggle");

    // Show
    await userEvent.click(toggle);
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Hide
    await userEvent.click(toggle);
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("toggles details pane with 'I' keyboard shortcut", async () => {
    await renderGallery();

    // Initially hidden
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();

    // Press I to show
    await userEvent.keyboard("i");
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Press I again to hide
    await userEvent.keyboard("i");
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("toggle button has correct aria-label reflecting current state", async () => {
    await renderGallery();

    const toggle = screen.getByTestId("gallery-info-toggle");
    expect(toggle).toHaveAttribute("aria-label", "Show details");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-label", "Hide details");
  });

  it("gallery-content gets --with-details class when pane is visible", async () => {
    await renderGallery();

    const content = screen.getByTestId("gallery-content");
    expect(content.classList.contains("gallery-content--with-details")).toBe(
      false,
    );

    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    expect(content.classList.contains("gallery-content--with-details")).toBe(
      true,
    );
  });

  it("details pane visibility persists across gallery remounts", async () => {
    const { unmount } = await renderGallery();

    // Open the pane
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Simulate closing and re-opening the gallery
    unmount();
    await renderGallery();

    // Pane should still be visible on remount (state persisted via localStorage)
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();
  });

  it("details pane closed state also persists across remounts", async () => {
    // Pre-seed localStorage with hidden state
    localStorage.setItem("media_library_gallery_details_visible", "0");

    const { unmount } = await renderGallery();
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();

    // Open it, then close it
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();

    // Remount — should still be hidden
    unmount();
    await renderGallery();
    expect(screen.queryByTestId("details-pane")).not.toBeInTheDocument();
  });

  it("starts at 360px and persists a pointer-resized width", async () => {
    const { unmount } = await renderGallery();
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    const region = screen.getByTestId("gallery-details-region");
    const handle = screen.getByRole("separator", {
      name: "Resize details pane",
    });
    expect(region).toHaveStyle({ width: "360px" });
    expect(handle).toHaveAttribute("aria-valuenow", "360");

    fireEvent.pointerDown(handle, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 420, pointerId: 1 });
    fireEvent.pointerUp(handle, { clientX: 420, pointerId: 1 });

    expect(region).toHaveStyle({ width: "440px" });
    expect(localStorage.getItem("media_library_gallery_details_width")).toBe(
      "440",
    );

    unmount();
    await renderGallery();
    expect(screen.getByTestId("gallery-details-region")).toHaveStyle({
      width: "440px",
    });
  });

  it("supports keyboard resizing without navigating the gallery", async () => {
    const onNavigate = vi.fn();
    await renderGallery({ onNavigate });
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    const handle = screen.getByRole("separator", {
      name: "Resize details pane",
    });
    handle.focus();
    fireEvent.keyDown(handle, { key: "ArrowLeft" });

    expect(screen.getByTestId("gallery-details-region")).toHaveStyle({
      width: "370px",
    });
    expect(onNavigate).not.toHaveBeenCalled();

    fireEvent.doubleClick(handle);
    expect(screen.getByTestId("gallery-details-region")).toHaveStyle({
      width: "360px",
    });
  });
});

describe("Gallery keyboard shortcuts", () => {
  it("recycles the current file after the existing confirmation", async () => {
    const onRecycleFile = vi.fn().mockResolvedValue(undefined);
    const drafts = mockTargetDraftsByFile({
      "2024/a.jpg": [newPropertyTargetDraft("Title", "pending title")],
    });
    await renderGallery({
      onRecycleFile,
      targetDraftEdits: drafts["2024/a.jpg"],
    });

    await userEvent.keyboard("{Delete}");

    await waitFor(() => expect(onRecycleFile).toHaveBeenCalledOnce());
    expect(onRecycleFile).toHaveBeenCalledWith("2024/a.jpg");
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("Move “a.jpg” to the Recycle Bin?"),
      { title: "Move to Recycle Bin", kind: "warning" },
    );
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("1 file has 1 pending metadata edit"),
      expect.anything(),
    );
  });

  it("does not recycle after cancellation or repeated Delete events", async () => {
    let resolveConfirmation!: (confirmed: boolean) => void;
    vi.mocked(ask).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const onRecycleFile = vi.fn();
    await renderGallery({ onRecycleFile });
    const gallery = screen.getByRole("dialog", { name: "File gallery" });

    fireEvent.keyDown(gallery, { key: "Delete" });
    fireEvent.keyDown(gallery, { key: "Delete" });
    fireEvent.keyDown(gallery, { key: "Delete", repeat: true });

    expect(ask).toHaveBeenCalledOnce();
    await act(async () => resolveConfirmation(false));
    expect(onRecycleFile).not.toHaveBeenCalled();
  });

  it("shares shortcut suppression across editable targets", async () => {
    const onNavigate = vi.fn();
    const onRecycleFile = vi.fn();
    await renderGallery({ onNavigate, onRecycleFile });
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));
    const search = document.getElementById("details-search-input");
    expect(search).toBeInstanceOf(HTMLInputElement);

    fireEvent.keyDown(search!, { key: "ArrowRight" });
    fireEvent.keyDown(search!, { key: "Delete" });

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    screen.getByRole("dialog", { name: "File gallery" }).append(editable);
    fireEvent.keyDown(editable, { key: "ArrowLeft" });
    fireEvent.keyDown(editable, { key: "Delete" });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(onRecycleFile).not.toHaveBeenCalled();
  });
});

describe("Gallery details pane content", () => {
  it("displays OS metadata for the current file", async () => {
    await renderGallery({ currentIndex: 0 });

    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    const osSection = screen.getByTestId("details-section-os");
    const osScroll = screen.getByTestId("details-section-scroll-os");
    expect(within(osSection).getByText("Filename")).toBeInTheDocument();
    expect(within(osSection).getByText("a.jpg")).toBeInTheDocument();
    expect(within(osSection).getByText("Relative Path")).toBeInTheDocument();
    expect(within(osSection).getByText("2024/a.jpg")).toBeInTheDocument();
    expect(osSection).toContainElement(osScroll);
    expect(within(osScroll).getByRole("table")).toBeInTheDocument();
  });

  it("shows loading state when metadata has not been received", async () => {
    const store = new FileMetadataOccurrencesStore();
    PHOTOS.forEach((p) => store.add(p.relative_path));
    // Don't set metadata — leave in "loading" state

    await renderGallery({ fileMetadataOccurrences: store });

    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    expect(screen.getByTestId("details-section-loading")).toBeInTheDocument();
    expect(screen.getByText("Loading metadata…")).toBeInTheDocument();
  });

  it("shows grouped image metadata when available", async () => {
    const onClose = vi.fn();
    const onNavigate = vi.fn();
    const onRecycleFile = vi.fn();
    const occurrences = new FileMetadataOccurrencesStore();
    occurrences.add("2024/a.jpg");
    occurrences.set("2024/a.jpg", [
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
        schema_id: { table: "Test::Fixture", tag_id: "IFD0:Make" },
        value: { kind: "Text", value: "Canon" },
        tag_info: {
          id: { table: "Test::Fixture", tag_id: "IFD0:Make" },
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
        write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "Make" },
      },
    ]);
    await renderGallery({
      fileMetadataOccurrences: occurrences,
      onSetExistingOccurrenceDraft: vi.fn(),
      onClose,
      onNavigate,
      onRecycleFile,
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("gallery-info-toggle"));

    fireEvent.contextMenu(screen.getByText("Canon"));
    const editButton = await screen.findByRole("button", { name: /^Edit/ });
    fireEvent.keyDown(editButton, { key: "ArrowRight" });
    fireEvent.keyDown(editButton, { key: "Delete" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    await user.click(editButton);

    const gallery = screen.getByRole("dialog", { name: "File gallery" });
    const editor = screen.getByRole("dialog", { name: "Edit IFD0:Make" });
    const cancel = within(editor).getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(cancel, { key: "ArrowLeft" });
    fireEvent.keyDown(cancel, { key: "Delete" });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    act(() => {
      editor.dispatchEvent(
        new Event("cancel", { bubbles: true, cancelable: true }),
      );
    });

    expect(
      screen.queryByRole("dialog", { name: "Edit IFD0:Make" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("gallery-content")).toBeInTheDocument();
    expect(gallery).toHaveAttribute("open");
    expect(onClose).not.toHaveBeenCalled();

    gallery.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("I key toggles details while Escape still closes gallery", async () => {
    const onClose = vi.fn();
    await renderGallery({ onClose });

    // Toggle details
    await userEvent.keyboard("i");
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Escape should close the gallery
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("arrow keys still navigate files when details pane is open", async () => {
    const onNavigate = vi.fn();
    await renderGallery({ onNavigate });

    // Open details
    await userEvent.keyboard("i");
    expect(screen.getByTestId("details-pane")).toBeInTheDocument();

    // Arrow keys should still call onNavigate
    await userEvent.keyboard("{ArrowRight}");
    expect(onNavigate).toHaveBeenCalledWith(1);

    await userEvent.keyboard("{ArrowLeft}");
    expect(onNavigate).toHaveBeenCalledWith(-1);
  });
});

describe("Gallery details pane with reactive metadata", () => {
  it("updates displayed metadata when metadata store receives new data", async () => {
    const store = new FileMetadataOccurrencesStore();
    PHOTOS.forEach((p) => store.add(p.relative_path));

    await renderGallery({ fileMetadataOccurrences: store, currentIndex: 0 });

    // Open details
    await userEvent.click(screen.getByTestId("gallery-info-toggle"));

    // Initially loading
    expect(screen.getByTestId("details-section-loading")).toBeInTheDocument();

    // Simulate metadata arriving via store update
    act(() => {
      store.set(
        "2024/a.jpg",
        occurrencesFromMetadataCollection(
          mockMetadata({
            "IFD0:Make": "Sony",
            "IFD0:Model": "A7R IV",
          }),
        ),
      );
    });

    // Wait for reactive update
    await waitFor(() => {
      expect(
        screen.queryByTestId("details-section-loading"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Sony")).toBeInTheDocument();
      expect(screen.getByText("A7R IV")).toBeInTheDocument();
    });
  });
});

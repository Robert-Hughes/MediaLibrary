// TypedValueEditor read-only routing tests.
//
// Regression coverage for the per-tag Save gate: when the schema reports
// `writable: false` for a tag, the editor must still open (so the user can
// view the value) but the Save button is disabled and the meta-hint banner
// is rendered in warning style with the "read-only" explainer text.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { TypedValueEditor } from "../components/editors/TypedValueEditor";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";

// useTagInfo calls Tauri's invoke under the hood for any uncached key.
// We seed the cache for the keys the tests care about.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

beforeEach(() => {
  cleanup();
  _clearTagInfoCache();
});

describe("TypedValueEditor read-only enforcement", () => {
  it("disables Save and marks the banner read-only for a writable=false tag", async () => {
    _setTagInfoCacheEntry("EXIF:ExifVersion", {
      group: "EXIF",
      name: "ExifVersion",
      writable: false,
      kind: { kind: "Text" },
      description: "EXIF spec version, set by the camera firmware",
    });
    const onSave = vi.fn();
    render(
      <TypedValueEditor
        propertyKey="EXIF:ExifVersion"
        initialString="0231"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    // Banner shows read-only warning state.
    await waitFor(() => {
      const hint = screen.getByTestId("editor-meta-hint");
      expect(hint).toHaveAttribute("data-readonly", "true");
      expect(hint).toHaveTextContent("read-only");
    });
    // Save button is disabled with the schema-readonly tooltip.
    // (Tag routes through the legacy text fallback because kind=Text.)
    const dialog = screen.getByRole("button", { name: /save/i });
    expect(dialog).toBeDisabled();
    expect(dialog).toHaveAttribute(
      "title",
      "Tag is read-only per ExifTool schema",
    );
    fireEvent.click(dialog);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("leaves Save enabled and the banner non-warning for a writable tag", async () => {
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey="XMP-dc:Title"
        initialString="hello"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("editor-meta-hint")).toHaveAttribute(
        "data-readonly",
        "false",
      );
    });
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).not.toBeDisabled();
  });

  it("disables Save in the richer editor branches too (NumericEditor)", async () => {
    _setTagInfoCacheEntry("EXIF:Orientation", {
      group: "EXIF",
      name: "Orientation",
      writable: false,
      kind: { kind: "Integer", data: { min: 1, max: 8 } },
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey="EXIF:Orientation"
        initialString="1"
        initialVariant={1}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => {
      const save = screen.getByTestId(
        "numeric-editor-save",
      ) as HTMLButtonElement;
      expect(save).toBeDisabled();
    });
  });
});

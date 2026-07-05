// BagEditor unit tests (Phase 4 MVP).
//
// Verifies the chip editor closes the keywords-CSV corruption mode at the
// source: typing two distinct items must emit MetadataValue::List with two
// elements, never a single comma-joined string.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BagEditor } from "../components/editors/BagEditor";
import { initialItemsFrom } from "../components/editors/editorHelpers";

beforeEach(() => cleanup());

describe("BagEditor", () => {
  it("renders initial items as chips", () => {
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={["beach", "sunset"]}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const chips = screen.getAllByTestId("bag-editor-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("beach");
    expect(chips[1]).toHaveTextContent("sunset");
  });

  it("adds an item on Enter and emits semantic list draft on Save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={[]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("bag-editor-input");
    await user.click(input);
    await user.type(input, "beach{Enter}sunset{Enter}");
    await user.click(screen.getByTestId("bag-editor-save"));

    expect(onSave).toHaveBeenCalledOnce();
    const edit = onSave.mock.calls[0][0];
    expect(edit.intent).toBe("Set");
    expect(edit.value).toEqual({
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [
          { kind: "Text", value: "beach" },
          { kind: "Text", value: "sunset" },
        ],
      },
    });
  });

  it("adds an item on comma keypress", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={[]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("bag-editor-input");
    await user.click(input);
    await user.type(input, "a,b,c");
    await user.click(screen.getByTestId("bag-editor-save"));
    expect(onSave.mock.calls[0][0].value.value.items).toEqual([
      { kind: "Text", value: "a" },
      { kind: "Text", value: "b" },
      { kind: "Text", value: "c" },
    ]);
  });

  it("removes a chip via × button", () => {
    const onSave = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={["a", "b", "c"]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const removeBtns = screen.getAllByRole("button", { name: /Remove/ });
    fireEvent.click(removeBtns[1]); // remove "b"
    fireEvent.click(screen.getByTestId("bag-editor-save"));
    expect(onSave.mock.calls[0][0].value.value.items).toEqual([
      { kind: "Text", value: "a" },
      { kind: "Text", value: "c" },
    ]);
  });

  it("backspace on empty input removes the last chip", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={["a", "b"]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("bag-editor-input");
    await user.click(input);
    await user.keyboard("{Backspace}");
    await user.click(screen.getByTestId("bag-editor-save"));
    expect(onSave.mock.calls[0][0].value.value.items).toEqual([
      { kind: "Text", value: "a" },
    ]);
  });

  it("does not add duplicate chips", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={["beach"]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("bag-editor-input");
    await user.click(input);
    await user.type(input, "beach{Enter}");
    await user.click(screen.getByTestId("bag-editor-save"));
    expect(onSave.mock.calls[0][0].value.value.items).toEqual([
      { kind: "Text", value: "beach" },
    ]);
  });

  it("folds pending unentered text into the saved list", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={["beach"]}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("bag-editor-input");
    await user.click(input);
    await user.type(input, "sunset");
    // No Enter — click Save directly.
    await user.click(screen.getByTestId("bag-editor-save"));
    expect(onSave.mock.calls[0][0].value.value.items).toEqual([
      { kind: "Text", value: "beach" },
      { kind: "Text", value: "sunset" },
    ]);
  });

  it("Escape cancels", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <BagEditor
        propertyKey="XMP-dc:Subject"
        initialItems={["a"]}
        onSave={() => {}}
        onCancel={onCancel}
      />,
    );
    const input = screen.getByTestId("bag-editor-input");
    await user.click(input);
    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

describe("initialItemsFrom", () => {
  it("returns array for a MetadataValue::List input", () => {
    expect(
      initialItemsFrom({
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            { kind: "Text", value: "a" },
            { kind: "Text", value: "b" },
          ],
        },
      }),
    ).toEqual(["a", "b"]);
  });

  it("parses comma-joined string (legacy display form)", () => {
    expect(initialItemsFrom("beach, sunset, vacation")).toEqual([
      "beach",
      "sunset",
      "vacation",
    ]);
  });

  it("returns empty for null/undefined", () => {
    expect(initialItemsFrom(null)).toEqual([]);
    expect(initialItemsFrom(undefined)).toEqual([]);
  });

  it("returns empty for empty string", () => {
    expect(initialItemsFrom("")).toEqual([]);
  });

  it("trims whitespace and drops empty fragments", () => {
    expect(initialItemsFrom("  a , , b  ")).toEqual(["a", "b"]);
  });
});

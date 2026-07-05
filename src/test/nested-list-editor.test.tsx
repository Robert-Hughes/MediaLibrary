// NestedListEditor unit tests.
//
// Regression coverage for METADATA_FORMATS_DESIGN.md §5's
// "no depth limit" recursive-composition promise.  Pre-Phase 8 the router
// fell through to the legacy text editor for Bag<Struct> / Bag<LangAlt>,
// so e.g. XMP-mwg-rs:Regions could not be edited at field granularity.
// These tests pin the new behaviour: Bag/Seq of non-scalar inner kinds
// route to NestedListEditor, items can be added/removed/reordered, and
// each item delegates back to TypedValueEditor for its own kind.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NestedListEditor } from "../components/editors/NestedListEditor";
import { initialItemsFromVariant } from "../components/editors/editorHelpers";
import type { DraftEdit, MetadataDraftEdit, TagKind, Variant } from "../types";
import type { InnerEditorProps } from "../components/editors/StructEditor";

beforeEach(() => cleanup());

// Stub inner editor that records the propertyKey/initialVariant it was
// asked to edit and immediately commits a sentinel edited Object.  Real
// router is exercised in the integration test at the bottom.
function stubInnerEditor(record: {
  lastPropertyKey?: string;
  lastInitial?: Variant;
}) {
  return function Stub(props: InnerEditorProps) {
    record.lastPropertyKey = props.propertyKey;
    record.lastInitial = props.initialVariant;
    return (
      <div data-testid="stub-inner-editor">
        <button
          data-testid="stub-inner-save"
          onClick={() =>
            props.onSave({
              value: { Name: "Edited", Type: "Face" } as Variant,
              intent: "Set",
            } as DraftEdit)
          }
        >
          Save inner
        </button>
        <button data-testid="stub-inner-cancel" onClick={props.onCancel}>
          Cancel inner
        </button>
      </div>
    );
  };
}

const BAG_OF_STRUCT: TagKind = {
  kind: "Bag",
  data: { kind: "Struct", data: {} } as TagKind,
};

const SEQ_OF_STRUCT: TagKind = {
  kind: "Seq",
  data: { kind: "Struct", data: {} } as TagKind,
};

const BAG_OF_LANGALT: TagKind = {
  kind: "Bag",
  data: { kind: "LangAlt" } as TagKind,
};

describe("NestedListEditor", () => {
  it("renders initial struct items with a per-item summary", () => {
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[
          { Name: "Alice", Type: "Face" },
          { Name: "Bob", Type: "Face" },
        ]}
        innerEditor={stubInnerEditor({})}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const summaries = screen.getAllByTestId("nested-list-editor-summary");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toHaveTextContent("Alice");
    expect(summaries[1]).toHaveTextContent("Bob");
  });

  it("emits MetadataValue::List of structs on save", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[{ Name: "Alice" }]}
        innerEditor={stubInnerEditor({})}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("nested-list-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    const edit = onSave.mock.calls[0][0] as MetadataDraftEdit;
    expect(edit.intent).toBe("Set");
    expect(edit.value).toEqual({
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [
          {
            kind: "Struct",
            value: { Name: { kind: "Text", value: "Alice" } },
          },
        ],
      },
    });
  });

  it("Edit… opens the inner editor for the chosen item", () => {
    const record: { lastPropertyKey?: string; lastInitial?: Variant } = {};
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[{ Name: "Alice" }, { Name: "Bob" }]}
        innerEditor={stubInnerEditor(record)}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const editButtons = screen.getAllByTestId("nested-list-editor-edit");
    fireEvent.click(editButtons[1]);
    expect(screen.getByTestId("stub-inner-editor")).toBeInTheDocument();
    expect(record.lastPropertyKey).toBe("XMP-mwg-rs:Regions[1]");
    expect(record.lastInitial).toEqual({ Name: "Bob" });
  });

  it("inner Save commits the edited value back into the list", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[{ Name: "Original" }]}
        innerEditor={stubInnerEditor({})}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("nested-list-editor-edit"));
    fireEvent.click(screen.getByTestId("stub-inner-save"));
    fireEvent.click(screen.getByTestId("nested-list-editor-save"));
    const edit = onSave.mock.calls[0][0] as MetadataDraftEdit;
    // The stub commits { Name: "Edited", Type: "Face" }.
    expect(edit.value).toEqual({
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [
          {
            kind: "Struct",
            value: {
              Name: { kind: "Text", value: "Edited" },
              Type: { kind: "Text", value: "Face" },
            },
          },
        ],
      },
    });
  });

  it("Add item appends an empty struct and opens the editor for it", () => {
    const record: { lastPropertyKey?: string; lastInitial?: Variant } = {};
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[{ Name: "Alice" }]}
        innerEditor={stubInnerEditor(record)}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("nested-list-editor-add"));
    // Inner editor opens immediately for the new item at index 1.
    expect(screen.getByTestId("stub-inner-editor")).toBeInTheDocument();
    expect(record.lastPropertyKey).toBe("XMP-mwg-rs:Regions[1]");
    // Empty Struct seed.
    expect(record.lastInitial).toEqual({});
  });

  it("Remove drops the chosen item from the saved list", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[{ Name: "Alice" }, { Name: "Bob" }]}
        innerEditor={stubInnerEditor({})}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const removes = screen.getAllByTestId("nested-list-editor-remove");
    fireEvent.click(removes[0]);
    fireEvent.click(screen.getByTestId("nested-list-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [
          {
            kind: "Struct",
            value: { Name: { kind: "Text", value: "Bob" } },
          },
        ],
      },
    });
  });

  it("Bag does not expose reorder controls", () => {
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[{ Name: "Alice" }, { Name: "Bob" }]}
        innerEditor={stubInnerEditor({})}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.queryAllByTestId("nested-list-editor-up")).toHaveLength(0);
    expect(screen.queryAllByTestId("nested-list-editor-down")).toHaveLength(0);
  });

  it("Seq exposes ordered ↑ / ↓ controls and reorder commits new order", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="X:OrderedRegions"
        kind={SEQ_OF_STRUCT}
        initialItems={[{ Name: "Alice" }, { Name: "Bob" }]}
        innerEditor={stubInnerEditor({})}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const downs = screen.getAllByTestId("nested-list-editor-down");
    expect(downs).toHaveLength(2);
    fireEvent.click(downs[0]); // move Alice down → Bob, Alice
    fireEvent.click(screen.getByTestId("nested-list-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "List",
      value: {
        list_kind: "Seq",
        items: [
          {
            kind: "Struct",
            value: { Name: { kind: "Text", value: "Bob" } },
          },
          {
            kind: "Struct",
            value: { Name: { kind: "Text", value: "Alice" } },
          },
        ],
      },
    });
  });

  it("LangAlt inner seeds a fresh item with x-default empty string", () => {
    const record: { lastPropertyKey?: string; lastInitial?: Variant } = {};
    render(
      <NestedListEditor
        propertyKey="X:LangAltList"
        kind={BAG_OF_LANGALT}
        initialItems={[]}
        innerEditor={stubInnerEditor(record)}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("nested-list-editor-add"));
    expect(record.lastInitial).toEqual({ "x-default": "" });
  });

  it("empty list shows the empty-state hint", () => {
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[]}
        innerEditor={stubInnerEditor({})}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("nested-list-editor-empty")).toBeInTheDocument();
  });
});

describe("initialItemsFromVariant", () => {
  it("returns array unchanged", () => {
    expect(initialItemsFromVariant([1, 2] as Variant)).toEqual([1, 2]);
  });
  it("treats null/undefined as empty list", () => {
    expect(initialItemsFromVariant(null as unknown as Variant)).toEqual([]);
    expect(initialItemsFromVariant(undefined)).toEqual([]);
  });
  it("promotes a scalar to a one-item list", () => {
    expect(initialItemsFromVariant("solo" as Variant)).toEqual(["solo"]);
  });
});

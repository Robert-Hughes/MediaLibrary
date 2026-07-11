// NestedListEditor unit tests.
//
// Regression coverage for METADATA_FORMATS_DESIGN.md §5's
// "no depth limit" recursive-composition promise.  Previously the router
// fell through to the plain text fallback for Bag<Struct> / Bag<LangAlt>,
// so e.g. XMP-mwg-rs:Regions could not be edited at field granularity.
// These tests pin the current behaviour: Bag/Seq of non-scalar inner kinds
// route to NestedListEditor, items can be added/removed/reordered, and
// each item delegates back to TypedValueEditor for its own kind.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { NestedListEditor } from "../components/editors/NestedListEditor";
import { initialItemsFromMetadataValue } from "../components/editors/editorHelpers";
import type { MetadataDraftEdit, TagKind, MetadataValue } from "../types";
import type { InnerEditorProps } from "../components/editors/StructEditor";

beforeEach(() => cleanup());

// Stub inner editor that records the propertyKey/initialMetadataValue it was
// asked to edit and immediately commits a sentinel edited Object.  Real
// router is exercised in the integration test at the bottom.
function stubInnerEditor(record: {
  lastPropertyKey?: string;
  lastInitial?: MetadataValue;
}) {
  return function Stub(props: InnerEditorProps) {
    record.lastPropertyKey = props.propertyLabel;
    record.lastInitial = props.initialMetadataValue;
    return (
      <div data-testid="stub-inner-editor">
        <button
          data-testid="stub-inner-save"
          onClick={() =>
            props.onSaveMetadata({
              value: {
                kind: "Struct",
                value: {
                  Name: { kind: "Text", value: "Edited" },
                  Type: { kind: "Text", value: "Face" },
                },
              },
              intent: "Set",
            })
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

const BAG_OF_STRING_ENUM: TagKind = {
  kind: "Bag",
  data: {
    kind: "Enum",
    data: {
      repr: "String",
      options: [
        { code: "first", label: "First option" },
        { code: "second", label: "Second option" },
      ],
    },
  },
};

function enumIntentEditor(props: InnerEditorProps) {
  return (
    <div data-testid="enum-intent-editor">
      <button
        data-testid="enum-intent-save"
        onClick={() =>
          props.onSaveMetadata({
            intent: "Set",
            value: { kind: "Text", value: "first" },
            display: "First option",
          })
        }
      >
        Save child
      </button>
      <button
        data-testid="enum-intent-delete"
        onClick={() => props.onSaveMetadata({ intent: "Delete", value: null })}
      >
        Delete child
      </button>
      <button data-testid="enum-intent-cancel" onClick={props.onCancel}>
        Cancel child
      </button>
    </div>
  );
}

describe("NestedListEditor", () => {
  it("disables every mutation control for a read-only nested sequence", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP:ReadOnlySequence"
        kind={SEQ_OF_STRUCT}
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
          { kind: "Struct", value: { Name: { kind: "Text", value: "Bob" } } },
        ]}
        innerEditor={stubInnerEditor({})}
        onSave={onSave}
        onCancel={() => {}}
        readOnly
      />,
    );

    const summariesBefore = screen
      .getAllByTestId("nested-list-editor-summary")
      .map((node) => node.textContent);
    const controls = [
      screen.getByTestId("nested-list-editor-save"),
      screen.getByTestId("nested-list-editor-add"),
      ...screen.getAllByTestId("nested-list-editor-edit"),
      ...screen.getAllByTestId("nested-list-editor-remove"),
      ...screen.getAllByTestId("nested-list-editor-up"),
      ...screen.getAllByTestId("nested-list-editor-down"),
    ];
    controls.forEach((control) => {
      expect(control).toBeDisabled();
      fireEvent.click(control);
    });

    expect(
      screen
        .getAllByTestId("nested-list-editor-summary")
        .map((node) => node.textContent),
    ).toEqual(summariesBefore);
    expect(screen.queryByTestId("stub-inner-editor")).not.toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });
  it("does not add a staged enum item when its child editor is cancelled", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP:Choices"
        kind={BAG_OF_STRING_ENUM}
        initialItems={[]}
        innerEditor={enumIntentEditor}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("nested-list-editor-add"));
    fireEvent.click(screen.getByTestId("enum-intent-cancel"));
    fireEvent.click(screen.getByTestId("nested-list-editor-save"));

    expect(onSave).toHaveBeenCalledWith({
      intent: "Set",
      value: { kind: "List", value: { list_kind: "Bag", items: [] } },
    });
  });

  it("removes an existing item when its child editor emits Delete", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP:Choices"
        kind={BAG_OF_STRING_ENUM}
        initialItems={[
          { kind: "Text", value: "first" },
          { kind: "Text", value: "second" },
        ]}
        innerEditor={enumIntentEditor}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getAllByTestId("nested-list-editor-edit")[0]);
    fireEvent.click(screen.getByTestId("enum-intent-delete"));
    fireEvent.click(screen.getByTestId("nested-list-editor-save"));

    expect(onSave).toHaveBeenCalledWith({
      intent: "Set",
      value: {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [{ kind: "Text", value: "second" }],
        },
      },
    });
  });
  it("renders initial struct items with a per-item summary", () => {
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
          { kind: "Struct", value: { Name: { kind: "Text", value: "Bob" } } },
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
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
        ]}
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
    const record: { lastPropertyKey?: string; lastInitial?: MetadataValue } =
      {};
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
          { kind: "Struct", value: { Name: { kind: "Text", value: "Bob" } } },
        ]}
        innerEditor={stubInnerEditor(record)}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const editButtons = screen.getAllByTestId("nested-list-editor-edit");
    fireEvent.click(editButtons[1]);
    expect(screen.getByTestId("stub-inner-editor")).toBeInTheDocument();
    expect(record.lastPropertyKey).toBe("XMP-mwg-rs:Regions[1]");
    expect(record.lastInitial).toEqual({
      kind: "Struct",
      value: { Name: { kind: "Text", value: "Bob" } },
    });
  });

  it("inner Save commits the edited value back into the list", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[
          {
            kind: "Struct",
            value: { Name: { kind: "Text", value: "Original" } },
          },
        ]}
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
    const record: { lastPropertyKey?: string; lastInitial?: MetadataValue } =
      {};
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
        ]}
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
    expect(record.lastInitial).toEqual({ kind: "Struct", value: {} });
  });

  it("Remove drops the chosen item from the saved list", () => {
    const onSave = vi.fn();
    render(
      <NestedListEditor
        propertyKey="XMP-mwg-rs:Regions"
        kind={BAG_OF_STRUCT}
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
          { kind: "Struct", value: { Name: { kind: "Text", value: "Bob" } } },
        ]}
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
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
          { kind: "Struct", value: { Name: { kind: "Text", value: "Bob" } } },
        ]}
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
        initialItems={[
          { kind: "Struct", value: { Name: { kind: "Text", value: "Alice" } } },
          { kind: "Struct", value: { Name: { kind: "Text", value: "Bob" } } },
        ]}
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
    const record: { lastPropertyKey?: string; lastInitial?: MetadataValue } =
      {};
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
    expect(record.lastInitial).toEqual({
      kind: "LangAlt",
      value: { "x-default": "" },
    });
  });

  it.each([
    ["String", "first", { kind: "Text", value: "first" }],
    ["Integer", "7", { kind: "Integer", value: 7 }],
  ] as const)(
    "seeds Bag<Enum<%s>> from the first typed option",
    (repr, code, expected) => {
      const record: { lastInitial?: MetadataValue } = {};
      render(
        <NestedListEditor
          propertyKey="X:Enums"
          kind={{
            kind: "Bag",
            data: {
              kind: "Enum",
              data: {
                repr,
                options: [{ code, label: "First" }],
              },
            },
          }}
          initialItems={[]}
          innerEditor={stubInnerEditor(record)}
          onSave={() => {}}
          onCancel={() => {}}
        />,
      );
      fireEvent.click(screen.getByTestId("nested-list-editor-add"));
      expect(record.lastInitial).toEqual(expected);
    },
  );

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

describe("initialItemsFromMetadataValue", () => {
  it("returns items from List kind", () => {
    const listVal: MetadataValue = {
      kind: "List",
      value: {
        list_kind: "Bag",
        items: [
          { kind: "Integer", value: 1 },
          { kind: "Integer", value: 2 },
        ],
      },
    };
    expect(initialItemsFromMetadataValue(listVal)).toEqual([
      { kind: "Integer", value: 1 },
      { kind: "Integer", value: 2 },
    ]);
  });
  it("treats null/undefined as empty list", () => {
    expect(initialItemsFromMetadataValue(undefined)).toEqual([]);
  });
  it("promotes a scalar to a one-item list", () => {
    const scalarVal: MetadataValue = { kind: "Text", value: "solo" };
    expect(initialItemsFromMetadataValue(scalarVal)).toEqual([scalarVal]);
  });
});

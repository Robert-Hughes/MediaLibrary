// StructEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructEditor } from "../components/editors/StructEditor";
import { initialObjectFrom } from "../components/editors/editorHelpers";
import type { MetadataValue } from "../types";

beforeEach(() => cleanup());

describe("StructEditor", () => {
  it("renders one row per initial field", () => {
    render(
      <StructEditor
        propertyKey="XMP-mwg-rs:Region"
        initialObject={{
          Name: { kind: "Text", value: "Alice" },
          Type: { kind: "Text", value: "Face" },
        }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const rows = screen.getAllByTestId("struct-editor-row");
    expect(rows).toHaveLength(2);
  });

  it("emits MetadataValue::Struct on Save", () => {
    const onSave = vi.fn();
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{
          a: { kind: "Text", value: "1" },
          b: { kind: "Text", value: "2" },
        }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("struct-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0]).toEqual({
      value: {
        kind: "Struct",
        value: {
          a: { kind: "Text", value: "1" },
          b: { kind: "Text", value: "2" },
        },
      },
      intent: "Set",
    });
  });

  it("edits a field value inline", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{ Name: { kind: "Text", value: "Alice" } }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId(
      "struct-editor-value-0",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Bob");
    fireEvent.click(screen.getByTestId("struct-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "Struct",
      value: { Name: { kind: "Text", value: "Bob" } },
    });
  });

  it("adds a new field", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{ a: { kind: "Text", value: "1" } }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const keyInput = screen.getByTestId(
      "struct-editor-new-key",
    ) as HTMLInputElement;
    await user.click(keyInput);
    await user.type(keyInput, "newField");
    await user.click(screen.getByTestId("struct-editor-add-btn"));
    fireEvent.click(screen.getByTestId("struct-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "Struct",
      value: {
        a: { kind: "Text", value: "1" },
        newField: { kind: "Text", value: "" },
      },
    });
  });

  it("removes a field via the × button", () => {
    const onSave = vi.fn();
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{
          a: { kind: "Text", value: "1" },
          b: { kind: "Text", value: "2" },
          c: { kind: "Text", value: "3" },
        }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const removeBtns = screen.getAllByRole("button", { name: /Remove/ });
    fireEvent.click(removeBtns[1]); // remove "b"
    fireEvent.click(screen.getByTestId("struct-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "Struct",
      value: {
        a: { kind: "Text", value: "1" },
        c: { kind: "Text", value: "3" },
      },
    });
  });

  it("renders a preview + Edit… button for complex inner values", () => {
    const inner = vi
      .fn()
      .mockReturnValue(<div data-testid="mock-inner-editor" />);
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{
          Name: { kind: "Text", value: "Alice" },
          Nested: {
            kind: "Struct",
            value: {
              a: { kind: "Text", value: "1" },
              b: { kind: "Text", value: "2" },
            },
          },
        }}
        innerEditor={inner}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("struct-editor-preview-1")).toBeInTheDocument();
    expect(screen.getByTestId("struct-editor-edit-1")).toBeInTheDocument();
  });

  it("recurses into innerEditor when Edit… is clicked on a complex field", () => {
    const inner = vi
      .fn()
      .mockReturnValue(<div data-testid="mock-inner-editor" />);
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{
          Nested: {
            kind: "Struct",
            value: { a: { kind: "Text", value: "1" } },
          },
        }}
        innerEditor={inner}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("struct-editor-edit-0"));
    expect(screen.getByTestId("mock-inner-editor")).toBeInTheDocument();
    expect(inner).toHaveBeenCalled();
  });

  it("removes a schema-aware field when its inner editor returns Delete", () => {
    const onSave = vi.fn();
    render(
      <StructEditor
        propertyKey="X"
        initialObject={{
          Enabled: { kind: "Bool", value: true },
          Name: { kind: "Text", value: "Alice" },
        }}
        fieldKinds={{ Enabled: { kind: "Boolean" }, Name: { kind: "Text" } }}
        innerEditor={(props) => (
          <button
            data-testid="delete-inner"
            onClick={() =>
              props.onSaveMetadata({ value: null, intent: "Delete" })
            }
          >
            Unset
          </button>
        )}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("struct-editor-edit-0"));
    fireEvent.click(screen.getByTestId("delete-inner"));
    expect(screen.queryByDisplayValue("Enabled")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("Name")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("struct-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "Struct",
      value: { Name: { kind: "Text", value: "Alice" } },
    });
  });
});

describe("initialObjectFrom", () => {
  it("passes through an object", () => {
    const structVal: MetadataValue = {
      kind: "Struct",
      value: { a: { kind: "Text", value: "1" } },
    };
    expect(initialObjectFrom(structVal)).toEqual({
      a: { kind: "Text", value: "1" },
    });
  });

  it("returns empty for non-object inputs", () => {
    expect(initialObjectFrom(undefined)).toEqual({});
    expect(initialObjectFrom({ kind: "Null" })).toEqual({});
    expect(initialObjectFrom({ kind: "Text", value: "a string" })).toEqual({});
    expect(initialObjectFrom({ kind: "Integer", value: 42 })).toEqual({});
    expect(
      initialObjectFrom({
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [
            { kind: "Text", value: "a" },
            { kind: "Text", value: "b" },
          ],
        },
      }),
    ).toEqual({});
  });
});

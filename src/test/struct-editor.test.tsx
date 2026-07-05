// StructEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StructEditor } from "../components/editors/StructEditor";
import { initialObjectFrom } from "../components/editors/editorHelpers";

beforeEach(() => cleanup());

describe("StructEditor", () => {
  it("renders one row per initial field", () => {
    render(
      <StructEditor
        propertyKey="XMP-mwg-rs:Region"
        initialObject={{ Name: "Alice", Type: "Face" }}
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
        initialObject={{ a: "1", b: "2" }}
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
        initialObject={{ Name: "Alice" }}
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
        initialObject={{ a: "1" }}
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
        initialObject={{ a: "1", b: "2", c: "3" }}
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
          Name: "Alice",
          Nested: { a: "1", b: "2" },
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
        initialObject={{ Nested: { a: "1" } }}
        innerEditor={inner}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("struct-editor-edit-0"));
    expect(screen.getByTestId("mock-inner-editor")).toBeInTheDocument();
    expect(inner).toHaveBeenCalled();
  });
});

describe("initialObjectFrom", () => {
  it("passes through an object", () => {
    expect(initialObjectFrom({ a: "1" })).toEqual({ a: "1" });
  });

  it("returns empty for non-object inputs", () => {
    expect(initialObjectFrom(undefined)).toEqual({});
    expect(initialObjectFrom(null)).toEqual({});
    expect(initialObjectFrom("a string")).toEqual({});
    expect(initialObjectFrom(42)).toEqual({});
    expect(initialObjectFrom(["a", "b"])).toEqual({});
  });
});

// EnumEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnumEditor } from "../components/editors/EnumEditor";
import { initialCodeFrom } from "../components/editors/editorHelpers";

beforeEach(() => cleanup());

const orientationOptions = [
  { code: "1", label: "Horizontal (normal)" },
  { code: "3", label: "Rotate 180" },
  { code: "6", label: "Rotate 90 CW" },
  { code: "8", label: "Rotate 270 CW" },
];

describe("EnumEditor", () => {
  it("renders dropdown with all options", () => {
    render(
      <EnumEditor
        propertyKey="IFD0:Orientation"
        repr="Integer"
        options={orientationOptions}
        initialCode="6"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId(
      "enum-editor-select",
    ) as HTMLSelectElement;
    expect(select.value).toBe("6");
    // 4 options + Custom…
    expect(select.querySelectorAll("option")).toHaveLength(5);
  });

  it("emits MetadataValue::Integer on Save for Integer repr", async () => {
    const onSave = vi.fn();
    render(
      <EnumEditor
        propertyKey="IFD0:Orientation"
        repr="Integer"
        options={orientationOptions}
        initialCode="6"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId(
      "enum-editor-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    const edit = onSave.mock.calls[0][0];
    expect(edit.intent).toBe("Set");
    expect(edit.value).toEqual({ kind: "Integer", value: 3 });
    expect(edit.display).toBe("Rotate 180");
  });

  it("emits raw code as display when Custom… code is out-of-spec", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EnumEditor
        propertyKey="X"
        repr="Integer"
        options={orientationOptions}
        initialCode="9"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const customInput = screen.getByTestId(
      "enum-editor-custom",
    ) as HTMLInputElement;
    await user.clear(customInput);
    await user.type(customInput, "11");
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].display).toBe("11");
  });

  it("emits schema label as display for in-spec String repr", () => {
    const onSave = vi.fn();
    render(
      <EnumEditor
        propertyKey="X"
        repr="String"
        options={[
          { code: "yes", label: "Yes" },
          { code: "no", label: "No" },
        ]}
        initialCode="yes"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId(
      "enum-editor-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "no" } });
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].display).toBe("No");
  });

  it("emits MetadataValue::Text on Save for String repr", () => {
    const onSave = vi.fn();
    render(
      <EnumEditor
        propertyKey="X"
        repr="String"
        options={[
          { code: "yes", label: "Yes" },
          { code: "no", label: "No" },
        ]}
        initialCode="yes"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId(
      "enum-editor-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "no" } });
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "Text",
      value: "no",
    });
  });

  it("switches to custom input on Custom… selection", () => {
    render(
      <EnumEditor
        propertyKey="X"
        repr="Integer"
        options={orientationOptions}
        initialCode="6"
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId(
      "enum-editor-select",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "__custom__" } });
    expect(screen.queryByTestId("enum-editor-select")).toBeNull();
    expect(screen.getByTestId("enum-editor-custom")).toBeInTheDocument();
  });

  it("starts in custom mode when initial code is out-of-spec", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <EnumEditor
        propertyKey="X"
        repr="Integer"
        options={orientationOptions}
        initialCode="9"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const customInput = screen.getByTestId(
      "enum-editor-custom",
    ) as HTMLInputElement;
    expect(customInput.value).toBe("9");
    await user.clear(customInput);
    await user.type(customInput, "11");
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({
      kind: "Integer",
      value: 11,
    });
  });
});

describe("initialCodeFrom", () => {
  it("uses the semantic integer code", () => {
    expect(
      initialCodeFrom({ kind: "Integer", value: 6 }, orientationOptions),
    ).toBe("6");
  });

  it("resolves a raw value that is actually a display label to its code", () => {
    // exiftool without -n returns the pretty label as the variant.  Must
    // still land us on the enum dropdown, not Custom mode.
    expect(
      initialCodeFrom(
        { kind: "Text", value: "Rotate 90 CW" },
        orientationOptions,
      ),
    ).toBe("6");
  });

  it("resolves a numeric raw code string to its option code", () => {
    expect(
      initialCodeFrom(
        { kind: "Text", value: "6" },
        orientationOptions,
      ),
    ).toBe("6");
  });

  it("returns first option code as last resort", () => {
    expect(initialCodeFrom(undefined, orientationOptions)).toBe("1");
  });
});

// EnumEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EnumEditor, initialCodeFrom } from "../components/editors/EnumEditor";

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
    const select = screen.getByTestId("enum-editor-select") as HTMLSelectElement;
    expect(select.value).toBe("6");
    // 4 options + Custom…
    expect(select.querySelectorAll("option")).toHaveLength(5);
  });

  it("emits numeric Variant on Save for Integer repr", async () => {
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
    const select = screen.getByTestId("enum-editor-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "3" } });
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    const edit = onSave.mock.calls[0][0];
    expect(edit.intent).toBe("Set");
    expect(edit.value).toBe(3);
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
    const customInput = screen.getByTestId("enum-editor-custom") as HTMLInputElement;
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
        options={[{ code: "yes", label: "Yes" }, { code: "no", label: "No" }]}
        initialCode="yes"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId("enum-editor-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "no" } });
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].display).toBe("No");
  });

  it("emits string Variant on Save for String repr", () => {
    const onSave = vi.fn();
    render(
      <EnumEditor
        propertyKey="X"
        repr="String"
        options={[{ code: "yes", label: "Yes" }, { code: "no", label: "No" }]}
        initialCode="yes"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const select = screen.getByTestId("enum-editor-select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "no" } });
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].value).toBe("no");
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
    const select = screen.getByTestId("enum-editor-select") as HTMLSelectElement;
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
    const customInput = screen.getByTestId("enum-editor-custom") as HTMLInputElement;
    expect(customInput.value).toBe("9");
    await user.clear(customInput);
    await user.type(customInput, "11");
    fireEvent.click(screen.getByTestId("enum-editor-save"));
    expect(onSave.mock.calls[0][0].value).toBe(11);
  });
});

describe("initialCodeFrom", () => {
  it("prefers raw value over display label", () => {
    expect(initialCodeFrom(6, "Rotate 90 CW", orientationOptions)).toBe("6");
  });

  it("falls back to label→code lookup", () => {
    expect(initialCodeFrom(undefined, "Rotate 90 CW", orientationOptions)).toBe("6");
  });

  it("returns the display value when no schema match", () => {
    expect(initialCodeFrom(undefined, "Custom-thing", orientationOptions)).toBe("Custom-thing");
  });

  it("returns first option code as last resort", () => {
    expect(initialCodeFrom(undefined, undefined, orientationOptions)).toBe("1");
  });
});

// NumericEditor, BooleanEditor, DateTimeEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumericEditor } from "../components/editors/NumericEditor";
import { BooleanEditor } from "../components/editors/BooleanEditor";
import { DateTimeEditor, toIsoLocal, toExiftoolFormat } from "../components/editors/DateTimeEditor";

beforeEach(() => cleanup());

describe("NumericEditor", () => {
  it("Integer save emits Variant::Integer", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NumericEditor
        propertyKey="XMP-xmp:Rating"
        kind="Integer"
        min={0}
        max={5}
        initialValue="3"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("numeric-editor-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "5");
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({ value: 5, intent: "Set" });
  });

  it("Integer rejects non-integer input", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NumericEditor
        propertyKey="X"
        kind="Integer"
        initialValue=""
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("numeric-editor-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "3.5");
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("numeric-editor-error")).toHaveTextContent("integer");
  });

  it("Integer clamps with bounds error", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NumericEditor
        propertyKey="X"
        kind="Integer"
        min={0}
        max={5}
        initialValue="0"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("numeric-editor-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "10");
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("numeric-editor-error")).toHaveTextContent("≤ 5");
  });

  it("readOnly disables Save and ignores clicks", async () => {
    const onSave = vi.fn();
    render(
      <NumericEditor
        propertyKey="EXIF:ExifVersion"
        kind="Integer"
        initialValue="42"
        readOnly
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const saveBtn = screen.getByTestId("numeric-editor-save") as HTMLButtonElement;
    expect(saveBtn).toBeDisabled();
    expect(saveBtn).toHaveAttribute("title", "Tag is read-only per ExifTool schema");
    fireEvent.click(saveBtn);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Real accepts decimal", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <NumericEditor
        propertyKey="X"
        kind="Real"
        initialValue=""
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("numeric-editor-input") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "5.6");
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(onSave.mock.calls[0][0].value).toBeCloseTo(5.6, 9);
  });
});

describe("BooleanEditor", () => {
  it("Save emits Variant::Bool", () => {
    const onSave = vi.fn();
    render(
      <BooleanEditor propertyKey="X" initialValue={false} onSave={onSave} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("boolean-editor-true"));
    fireEvent.click(screen.getByTestId("boolean-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({ value: true, intent: "Set" });
  });

  it("Unset → Delete intent", () => {
    const onSave = vi.fn();
    render(
      <BooleanEditor propertyKey="X" initialValue={true} onSave={onSave} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("boolean-editor-unset"));
    fireEvent.click(screen.getByTestId("boolean-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({ value: null, intent: "Delete" });
  });
});

describe("DateTimeEditor", () => {
  it("Save emits exiftool-format string", () => {
    const onSave = vi.fn();
    render(
      <DateTimeEditor
        propertyKey="EXIF:DateTimeOriginal"
        initialValue="2024:01:15 14:30:00"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("datetime-editor-save"));
    expect(onSave.mock.calls[0][0].value).toBe("2024:01:15 14:30:00");
  });

  it("rejects invalid input", () => {
    const onSave = vi.fn();
    render(
      <DateTimeEditor
        propertyKey="X"
        initialValue="garbage"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("datetime-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("datetime-editor-error")).toBeInTheDocument();
  });
});

describe("toIsoLocal / toExiftoolFormat", () => {
  it("round-trips a basic timestamp", () => {
    const exif = "2024:01:15 14:30:45";
    const iso = toIsoLocal(exif);
    expect(iso).toBe("2024-01-15T14:30:45");
    expect(toExiftoolFormat(iso)).toBe(exif);
  });

  it("toExiftoolFormat returns null for invalid", () => {
    expect(toExiftoolFormat("not a date")).toBeNull();
    expect(toExiftoolFormat("")).toBeNull();
  });

  it("toIsoLocal returns empty for invalid", () => {
    expect(toIsoLocal("not a date")).toBe("");
    expect(toIsoLocal("")).toBe("");
  });
});

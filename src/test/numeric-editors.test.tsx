// NumericEditor, BooleanEditor, DateTimeEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumericEditor } from "../components/editors/NumericEditor";
import { BooleanEditor } from "../components/editors/BooleanEditor";
import { DateTimeEditor } from "../components/editors/DateTimeEditor";
import {
  toIsoLocal,
  toExiftoolFormat,
} from "../components/editors/editorHelpers";
import { RationalEditor } from "../components/editors/RationalEditor";

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
    const input = screen.getByTestId(
      "numeric-editor-input",
    ) as HTMLInputElement;
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
    const input = screen.getByTestId(
      "numeric-editor-input",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "3.5");
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId("numeric-editor-error")).toHaveTextContent(
      "integer",
    );
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
    const input = screen.getByTestId(
      "numeric-editor-input",
    ) as HTMLInputElement;
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
    const saveBtn = screen.getByTestId(
      "numeric-editor-save",
    ) as HTMLButtonElement;
    expect(saveBtn).toBeDisabled();
    expect(saveBtn).toHaveAttribute(
      "title",
      "Tag is read-only per ExifTool schema",
    );
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
    const input = screen.getByTestId(
      "numeric-editor-input",
    ) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "5.6");
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(onSave.mock.calls[0][0].value).toBeCloseTo(5.6, 9);
  });
});

describe("BooleanEditor", () => {
  it("Save emits MetadataValue::Bool", () => {
    const onSave = vi.fn();
    render(
      <BooleanEditor
        propertyKey="X"
        initialValue={false}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("boolean-editor-true"));
    fireEvent.click(screen.getByTestId("boolean-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({
      value: { kind: "Bool", value: true },
      intent: "Set",
    });
  });

  it("Unset → Delete intent", () => {
    const onSave = vi.fn();
    render(
      <BooleanEditor
        propertyKey="X"
        initialValue={true}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("boolean-editor-unset"));
    fireEvent.click(screen.getByTestId("boolean-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({ value: null, intent: "Delete" });
  });
});

describe("DateTimeEditor", () => {
  it("date mode uses a date-only input and saves date storage format", () => {
    const onSave = vi.fn();
    render(
      <DateTimeEditor
        propertyKey="IPTC:DateCreated"
        mode="date"
        initialValue="2024-01-15"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("datetime-editor-input");
    expect(input).toHaveAttribute("type", "date");
    fireEvent.click(screen.getByTestId("datetime-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({
      value: {
        kind: "Date",
        value: { year: 2024, month: 1, day: 15 },
      },
      intent: "Set",
      display: "2024:01:15",
    });
  });

  it("time mode uses a time-only input and preserves an existing offset", () => {
    const onSave = vi.fn();
    render(
      <DateTimeEditor
        propertyKey="IPTC:TimeCreated"
        mode="time"
        initialValue="14:30:05+01:00"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("datetime-editor-input");
    expect(input).toHaveAttribute("type", "time");
    fireEvent.click(screen.getByTestId("datetime-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({
      value: {
        kind: "Time",
        value: {
          hour: 14,
          minute: 30,
          second: 5,
          subsecond: null,
          offset: { sign: "Plus", hours: 1, minutes: 0 },
        },
      },
      intent: "Set",
      display: "14:30:05+01:00",
    });
  });

  it("Save emits semantic DateTime with exiftool display", () => {
    const onSave = vi.fn();
    render(
      <DateTimeEditor
        propertyKey="ExifIFD:DateTimeOriginal"
        initialValue="2024:01:15 14:30:00"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("datetime-editor-input")).toHaveAttribute(
      "type",
      "datetime-local",
    );
    fireEvent.click(screen.getByTestId("datetime-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({
      value: {
        kind: "DateTime",
        value: {
          date: { year: 2024, month: 1, day: 15 },
          time: {
            hour: 14,
            minute: 30,
            second: 0,
            subsecond: null,
            offset: null,
          },
        },
      },
      intent: "Set",
      display: "2024:01:15 14:30:00",
    });
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

describe("RationalEditor", () => {
  it("emits fraction string as display in fraction mode", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <RationalEditor
        propertyKey="EXIF:ExposureTime"
        initialValue="1/250"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const num = screen.getByTestId("rational-editor-num") as HTMLInputElement;
    const den = screen.getByTestId("rational-editor-den") as HTMLInputElement;
    await user.clear(num);
    await user.type(num, "1");
    await user.clear(den);
    await user.type(den, "8000");
    fireEvent.click(screen.getByTestId("rational-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0][0].display).toBe("1/8000");
    expect(onSave.mock.calls[0][0].value).toBeCloseTo(1 / 8000, 9);
  });

  it("emits integer-form display when denominator is 1", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <RationalEditor
        propertyKey="X"
        initialValue="2/1"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    const num = screen.getByTestId("rational-editor-num") as HTMLInputElement;
    await user.clear(num);
    await user.type(num, "3");
    fireEvent.click(screen.getByTestId("rational-editor-save"));
    expect(onSave.mock.calls[0][0].display).toBe("3");
  });

  it("emits reduced fraction display in decimal mode", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <RationalEditor
        propertyKey="X"
        initialValue="0.5"
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("rational-editor-mode-decimal"));
    const dec = screen.getByTestId(
      "rational-editor-decimal",
    ) as HTMLInputElement;
    await user.clear(dec);
    await user.type(dec, "0.004");
    fireEvent.click(screen.getByTestId("rational-editor-save"));
    expect(onSave.mock.calls[0][0].display).toBe("1/250");
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

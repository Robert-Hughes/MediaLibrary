// FlashEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import {
  FlashEditor,
  decodeFlashCode,
  encodeFlashFields,
  isFlashTag,
} from "../components/editors/FlashEditor";

beforeEach(() => cleanup());

describe("decodeFlashCode / encodeFlashFields", () => {
  it("decodes 0 as everything-off", () => {
    expect(decodeFlashCode(0)).toEqual({
      fired: false,
      returnStatus: 0,
      mode: 0,
      noFunction: false,
      redEye: false,
    });
  });

  it("decodes 25 as Fired + Mode=Auto (fixture: flash_bitfield.jpg)", () => {
    const f = decodeFlashCode(25);
    expect(f.fired).toBe(true);
    expect(f.mode).toBe(3); // Auto
    expect(f.redEye).toBe(false);
    expect(f.noFunction).toBe(false);
  });

  it("decodes 16 as Off-not-fired (Mode=Compulsory-suppress)", () => {
    const f = decodeFlashCode(16);
    expect(f.fired).toBe(false);
    expect(f.mode).toBe(2);
  });

  it("encode is the inverse of decode for representable codes", () => {
    for (const code of [0, 1, 8, 9, 16, 24, 25, 32, 65, 89]) {
      const f = decodeFlashCode(code);
      expect(encodeFlashFields(f)).toBe(code);
    }
  });

  it("encodes red-eye bit", () => {
    expect(encodeFlashFields({
      fired: true, returnStatus: 0, mode: 3, noFunction: false, redEye: true,
    })).toBe(25 | 0b1000000); // 25 + 64 = 89
  });
});

describe("FlashEditor", () => {
  it("renders initial state from code", () => {
    render(
      <FlashEditor
        propertyKey="EXIF:Flash"
        initialCode={25}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByTestId("flash-editor-fired") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId("flash-editor-mode") as HTMLSelectElement).value).toBe("3");
  });

  it("shows the live code preview", () => {
    render(
      <FlashEditor
        propertyKey="EXIF:Flash"
        initialCode={25}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("flash-editor-code-preview")).toHaveTextContent("25");
  });

  it("toggling Red-eye updates the code in real time", () => {
    render(
      <FlashEditor
        propertyKey="EXIF:Flash"
        initialCode={25}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("flash-editor-red-eye"));
    expect(screen.getByTestId("flash-editor-code-preview")).toHaveTextContent("89");
  });

  it("Save emits the recomputed numeric code", () => {
    const onSave = vi.fn();
    render(
      <FlashEditor
        propertyKey="EXIF:Flash"
        initialCode={25}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("flash-editor-red-eye"));
    fireEvent.click(screen.getByTestId("flash-editor-save"));
    expect(onSave.mock.calls[0][0]).toEqual({ value: 89, intent: "Set" });
  });
});

describe("isFlashTag", () => {
  it("matches common group prefixes", () => {
    expect(isFlashTag("EXIF:Flash")).toBe(true);
    expect(isFlashTag("IFD0:Flash")).toBe(true);
    expect(isFlashTag("MakerNotes:Flash")).toBe(true);
    expect(isFlashTag("XMP-exif:Flash")).toBe(true);
  });

  it("does not match unrelated tags", () => {
    expect(isFlashTag("FlashMode")).toBe(false);
    expect(isFlashTag("EXIF:FlashCompensation")).toBe(false);
    expect(isFlashTag("Flash")).toBe(false);
  });
});

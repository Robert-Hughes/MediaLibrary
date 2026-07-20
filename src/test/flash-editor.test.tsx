// FlashEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FlashEditor } from "../components/editors/FlashEditor";
import {
  decodeFlashCode,
  encodeFlashFields,
  describeFlashCode,
} from "../components/editors/editorHelpers";
import { isFlashTag } from "../metadata/tag_overrides";
import { testId } from "./factories";

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
    expect(
      encodeFlashFields({
        fired: true,
        returnStatus: 0,
        mode: 3,
        noFunction: false,
        redEye: true,
      }),
    ).toBe(25 | 0b1000000); // 25 + 64 = 89
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
    expect(
      (screen.getByTestId("flash-editor-fired") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (screen.getByTestId("flash-editor-mode") as HTMLSelectElement).value,
    ).toBe("3");
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
    expect(screen.getByTestId("flash-editor-code-preview")).toHaveTextContent(
      "25",
    );
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
    expect(screen.getByTestId("flash-editor-code-preview")).toHaveTextContent(
      "89",
    );
  });

  it("Save emits the recomputed semantic integer code", () => {
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
    expect(onSave.mock.calls[0][0]).toEqual({
      value: { kind: "Integer", value: 89 },
      intent: "Set",
    });
  });
});

describe("describeFlashCode", () => {
  it("describes fired + auto + red-eye", () => {
    expect(describeFlashCode(decodeFlashCode(89))).toBe(
      "Fired, Auto, Red-eye reduction",
    );
  });
  it("collapses to 'No flash function' when that bit is set", () => {
    expect(describeFlashCode(decodeFlashCode(0b100000))).toBe(
      "No flash function",
    );
  });
  it("describes did-not-fire when bit 0 is clear", () => {
    expect(describeFlashCode(decodeFlashCode(0))).toBe("Did not fire");
  });
});

describe("isFlashTag", () => {
  it("matches the exact EXIF Flash schema definition", () => {
    expect(isFlashTag(testId("EXIF:Flash"))).toBe(true);
  });

  it("does not match unrelated tags", () => {
    expect(isFlashTag(testId("FlashMode"))).toBe(false);
    expect(isFlashTag(testId("EXIF:FlashCompensation"))).toBe(false);
    expect(isFlashTag(testId("Flash"))).toBe(false);
  });
});

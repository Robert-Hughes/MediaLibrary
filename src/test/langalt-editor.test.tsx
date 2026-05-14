// LangAltEditor unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LangAltEditor, initialLangsFrom } from "../components/editors/LangAltEditor";

beforeEach(() => cleanup());

describe("LangAltEditor", () => {
  it("always shows x-default tab even when initial is empty", () => {
    render(
      <LangAltEditor
        propertyKey="XMP-dc:Description"
        initialLangs={{}}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("langalt-editor-tab-x-default")).toBeInTheDocument();
  });

  it("emits an Object Variant keyed by language on Save", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    render(
      <LangAltEditor
        propertyKey="XMP-dc:Description"
        initialLangs={{ "x-default": "hello", en: "hello", fr: "bonjour" }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    await user.click(screen.getByTestId("langalt-editor-save"));
    expect(onSave).toHaveBeenCalledOnce();
    const edit = onSave.mock.calls[0][0];
    expect(edit.intent).toBe("Set");
    expect(edit.value).toEqual({ "x-default": "hello", en: "hello", fr: "bonjour" });
  });

  it("switches active tab on click", () => {
    render(
      <LangAltEditor
        propertyKey="X"
        initialLangs={{ "x-default": "a", en: "b" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByTestId("langalt-editor-textarea") as HTMLTextAreaElement).value).toBe("a");
    fireEvent.click(screen.getByTestId("langalt-editor-tab-en"));
    expect((screen.getByTestId("langalt-editor-textarea") as HTMLTextAreaElement).value).toBe("b");
  });

  it("adds a new language tab", async () => {
    const user = userEvent.setup();
    render(
      <LangAltEditor
        propertyKey="X"
        initialLangs={{ "x-default": "" }}
        onSave={() => {}}
        onCancel={() => {}}
      />,
    );
    const input = screen.getByTestId("langalt-editor-add-input") as HTMLInputElement;
    await user.click(input);
    await user.type(input, "de");
    await user.click(screen.getByTestId("langalt-editor-add-btn"));
    expect(screen.getByTestId("langalt-editor-tab-de")).toBeInTheDocument();
  });

  it("drops empty non-default languages on save but keeps x-default", () => {
    const onSave = vi.fn();
    render(
      <LangAltEditor
        propertyKey="X"
        initialLangs={{ "x-default": "", en: "" }}
        onSave={onSave}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("langalt-editor-save"));
    expect(onSave.mock.calls[0][0].value).toEqual({ "x-default": "" });
  });
});

describe("initialLangsFrom", () => {
  it("extracts from a Variant::Object base value", () => {
    const r = initialLangsFrom({ "x-default": "hi", en: "hi", fr: "salut" }, {}, "XMP-dc:Description");
    expect(r).toEqual({ "x-default": "hi", en: "hi", fr: "salut" });
  });

  it("gathers sibling -lang keys from the metadata map", () => {
    const meta = {
      "XMP-dc:Description": "default text",
      "XMP-dc:Description-en": "english",
      "XMP-dc:Description-fr": "francais",
      "OtherTag": "x",
    };
    const r = initialLangsFrom("default text", meta, "XMP-dc:Description");
    expect(r).toEqual({
      "x-default": "default text",
      en: "english",
      fr: "francais",
    });
  });

  it("returns empty for undefined input", () => {
    expect(initialLangsFrom(undefined, {}, "X")).toEqual({});
  });
});

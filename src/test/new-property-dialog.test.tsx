// NewPropertyDialog unit tests.
//
// The dialog is stage 1 of a two-step new-property flow: it only picks a
// key.  Stage 2 (a TypedValueEditor for that key) is owned by the parent
// (DetailsPane) and is exercised by the editor-specific test files.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewPropertyDialog } from "../components/NewPropertyDialog";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "../hooks/useTagInfo";
import {
  _resetSchemaTagNamesCache,
  _setSchemaTagNamesCache,
} from "../hooks/useSchemaTagNames";

// useTagInfo and useSchemaTagNames call Tauri's invoke under the hood.
// Seed caches via helpers; stub invoke as a no-op so uncached lookups
// don't crash in test mode.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

beforeEach(() => {
  cleanup();
  _clearTagInfoCache();
  _resetSchemaTagNamesCache();
});

describe("NewPropertyDialog", () => {
  it("renders empty form with Next disabled", () => {
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("new-property-key")).toBeInTheDocument();
    expect(screen.queryByTestId("new-property-value")).toBeNull();
    expect(screen.getByTestId("new-property-next")).toBeDisabled();
  });

  it("does not look up the schema until a colon is typed", async () => {
    const user = userEvent.setup();
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const keyInput = screen.getByTestId("new-property-key");
    await user.click(keyInput);
    await user.type(keyInput, "XMP-dc");
    expect(screen.queryByTestId("new-property-schema-info")).toBeNull();
    expect(screen.queryByTestId("new-property-schema-unknown")).toBeNull();
  });

  it("shows the unknown-tag warning when schema lookup misses", async () => {
    _setTagInfoCacheEntry("XMP-dc:NotARealTag", null);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const keyInput = screen.getByTestId("new-property-key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "XMP-dc:NotARealTag" } });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-schema-unknown")).toBeInTheDocument();
    });
  });

  it("shows the unwritable-tag warning and disables Next", async () => {
    _setTagInfoCacheEntry("Foo:Readonly", {
      group: "Foo",
      name: "Readonly",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Foo:Readonly" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-schema-unwritable")).toBeInTheDocument();
    });
    expect(screen.getByTestId("new-property-next")).toBeDisabled();
  });

  it("shows kind info for a known writable tag", async () => {
    _setTagInfoCacheEntry("XMP-dc:Subject", {
      group: "XMP-dc",
      name: "Subject",
      writable: true,
      kind: { kind: "Bag", data: { kind: "Text" } },
      description: "Subject keywords",
    });
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Subject" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-schema-info")).toBeInTheDocument();
    });
    const info = screen.getByTestId("new-property-schema-info");
    expect(info).toHaveTextContent("Bag");
    expect(info).toHaveTextContent("Subject keywords");
  });

  // ── Autocomplete ───────────────────────────────────────────────────────

  it("datalist contains matching schema tag suggestions", async () => {
    _setSchemaTagNamesCache([
      "XMP-dc:Title",
      "XMP-dc:Subject",
      "XMP-dc:Description",
      "IPTC:Keywords",
    ]);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc" },
    });
    await waitFor(() => {
      const datalist = document.getElementById("schema-tag-names");
      expect(datalist).not.toBeNull();
      const options = datalist!.querySelectorAll("option");
      const values = Array.from(options).map((o) => o.getAttribute("value"));
      expect(values).toContain("XMP-dc:Title");
      expect(values).toContain("XMP-dc:Subject");
      expect(values).toContain("XMP-dc:Description");
      expect(values).not.toContain("IPTC:Keywords");
    });
  });

  it("filters out groups inapplicable to the file extension", async () => {
    _setSchemaTagNamesCache([
      "IFD0:Make",
      "ExifIFD:ExifVersion",
      "Vorbis:Title",
      "FLAC:Picture",
      "XMP-dc:Title",
    ]);
    render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        filename="photo.jpg"
      />,
    );
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "i" }, // case-insensitive substring
    });
    await waitFor(() => {
      const datalist = document.getElementById("schema-tag-names");
      const values = Array.from(datalist!.querySelectorAll("option")).map((o) => o.getAttribute("value"));
      expect(values).toContain("IFD0:Make");
      expect(values).toContain("XMP-dc:Title");
      // Audio-only groups must not surface on a JPEG.
      expect(values).not.toContain("Vorbis:Title");
      expect(values).not.toContain("FLAC:Picture");
    });
  });

  it("datalist exposes the full applicable list when the input is blank", async () => {
    // Empty-input case: we want the browser to surface the dropdown arrow
    // so the user can browse before typing.  Pass no filename so the list
    // is unfiltered.
    _setSchemaTagNamesCache(["XMP-dc:Title", "IPTC:Keywords"]);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const datalist = document.getElementById("schema-tag-names");
    expect(datalist).not.toBeNull();
    const values = Array.from(datalist!.querySelectorAll("option")).map((o) => o.getAttribute("value"));
    expect(values).toEqual(["XMP-dc:Title", "IPTC:Keywords"]);
  });

  // ── Duplicate-key warning ──────────────────────────────────────────────

  it("shows overwrite warning when key matches an existing metadata key", async () => {
    const existingKeys = new Set(["XMP-dc:Title", "IPTC:Keywords"]);
    render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        existingKeys={existingKeys}
      />
    );
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("new-property-duplicate-warning")
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("new-property-duplicate-warning")).toHaveTextContent(
      "already exists"
    );
  });

  it("shows overwrite warning when key matches a draft edit key", async () => {
    const existingKeys = new Set(["XMP-dc:Creator"]);
    render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        existingKeys={existingKeys}
      />
    );
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Creator" },
    });
    await waitFor(() => {
      expect(
        screen.getByTestId("new-property-duplicate-warning")
      ).toBeInTheDocument();
    });
  });

  it("does not show overwrite warning when key is not in existingKeys", async () => {
    const existingKeys = new Set(["XMP-dc:Title"]);
    render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        existingKeys={existingKeys}
      />
    );
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Description" },
    });
    expect(
      screen.queryByTestId("new-property-duplicate-warning")
    ).toBeNull();
  });

  it("does not show overwrite warning when existingKeys not provided", async () => {
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    expect(
      screen.queryByTestId("new-property-duplicate-warning")
    ).toBeNull();
  });

  it("overwrite warning clears when key changes to non-duplicate", async () => {
    const existingKeys = new Set(["XMP-dc:Title"]);
    render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        existingKeys={existingKeys}
      />
    );
    const keyInput = screen.getByTestId("new-property-key");
    fireEvent.change(keyInput, { target: { value: "XMP-dc:Title" } });
    await waitFor(() => {
      expect(
        screen.getByTestId("new-property-duplicate-warning")
      ).toBeInTheDocument();
    });
    fireEvent.change(keyInput, { target: { value: "XMP-dc:Description" } });
    await waitFor(() => {
      expect(
        screen.queryByTestId("new-property-duplicate-warning")
      ).toBeNull();
    });
  });

  // ── Stage transition ───────────────────────────────────────────────────

  it("Next still works when key is a duplicate (overwrite is allowed)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const existingKeys = new Set(["XMP-dc:Title"]);
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(
      <NewPropertyDialog
        onSave={onSave}
        onCancel={() => {}}
        existingKeys={existingKeys}
      />
    );
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith("XMP-dc:Title");
  });

  it("Next calls onSave with just the key (no value field)", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "XMP-dc:Title" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith("XMP-dc:Title");
  });

  it("Next is enabled even before a colon is typed (key not in schema → text fallback)", async () => {
    const onSave = vi.fn();
    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "FreeFormKey" },
    });
    expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
  });

  it("Enter on the key field advances when valid", async () => {
    const onSave = vi.fn();
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);
    const keyInput = screen.getByTestId("new-property-key");
    fireEvent.change(keyInput, { target: { value: "XMP-dc:Title" } });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-next")).not.toBeDisabled();
    });
    fireEvent.keyDown(keyInput, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("XMP-dc:Title");
  });

  it("Enter does not advance while the tag is unwritable", async () => {
    const onSave = vi.fn();
    _setTagInfoCacheEntry("Foo:Readonly", {
      group: "Foo",
      name: "Readonly",
      writable: false,
      kind: { kind: "Text" },
      description: null,
    });
    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);
    const keyInput = screen.getByTestId("new-property-key");
    fireEvent.change(keyInput, { target: { value: "Foo:Readonly" } });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-schema-unwritable")).toBeInTheDocument();
    });
    fireEvent.keyDown(keyInput, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
  });
});

// NewPropertyDialog unit tests.

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
  it("renders empty form", () => {
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("new-property-key")).toBeInTheDocument();
    expect(screen.getByTestId("new-property-value")).toBeInTheDocument();
    expect(screen.getByTestId("new-property-add")).toBeDisabled();
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
    // Pre-seed the cache so we don't need to wait for the async lookup.
    _setTagInfoCacheEntry("XMP-dc:NotARealTag", null);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const keyInput = screen.getByTestId("new-property-key") as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: "XMP-dc:NotARealTag" } });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-schema-unknown")).toBeInTheDocument();
    });
  });

  it("shows the unwritable-tag warning and disables Add", async () => {
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
    fireEvent.change(screen.getByTestId("new-property-value"), {
      target: { value: "anything" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-schema-unwritable")).toBeInTheDocument();
    });
    expect(screen.getByTestId("new-property-add")).toBeDisabled();
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

  it("datalist is empty when input is blank", async () => {
    _setSchemaTagNamesCache(["XMP-dc:Title", "IPTC:Keywords"]);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    // key input starts empty — no suggestions
    const datalist = document.getElementById("schema-tag-names");
    expect(datalist).not.toBeNull();
    expect(datalist!.querySelectorAll("option")).toHaveLength(0);
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

  it("Save still works when key is a duplicate (overwrite is allowed)", async () => {
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
    fireEvent.change(screen.getByTestId("new-property-value"), {
      target: { value: "New Title" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-add")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-add"));
    expect(onSave).toHaveBeenCalledWith("XMP-dc:Title", "New Title");
  });

  it("Save calls onSave with key and value", async () => {
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
    fireEvent.change(screen.getByTestId("new-property-value"), {
      target: { value: "Hello" },
    });
    await waitFor(() => {
      expect(screen.getByTestId("new-property-add")).not.toBeDisabled();
    });
    await user.click(screen.getByTestId("new-property-add"));
    expect(onSave).toHaveBeenCalledWith("XMP-dc:Title", "Hello");
  });
});

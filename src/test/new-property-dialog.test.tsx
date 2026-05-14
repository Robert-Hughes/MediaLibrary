// NewPropertyDialog unit tests.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewPropertyDialog } from "../components/NewPropertyDialog";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "../hooks/useTagInfo";

// useTagInfo calls Tauri's invoke under the hood for any uncached key.
// We seed the cache for the keys the tests care about; intermediate
// partial-typed keys (e.g. while the user is still typing past the colon)
// fall through and would otherwise crash in test mode.  Stub invoke as a
// no-op that resolves to null.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

beforeEach(() => {
  cleanup();
  _clearTagInfoCache();
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

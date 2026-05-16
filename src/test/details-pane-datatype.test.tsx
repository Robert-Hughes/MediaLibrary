/**
 * DetailsPane datatype-badge integration tests.
 *
 * Covers every interesting combination of schema-declared kind, runtime
 * value type, and pending draft type, exercising the
 * schemaDatatype/variantDatatype/datatypesMatch rules through the
 * rendered DOM.
 */
import { render, screen, within, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";
import type { DraftEdit, TagInfo, TagKind, Variant } from "../types";
import { makePhoto } from "./factories";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

function tagInfo(group: string, name: string, kind: TagKind, writable = true): TagInfo {
  return { group, name, writable, kind, description: null };
}

function findRow(key: string): HTMLElement {
  const rows = screen.getAllByTestId("details-row");
  const match = rows.find((r) => r.getAttribute("data-row-key") === key);
  if (!match) throw new Error(`row for key ${key} not found`);
  return match;
}

const photo = makePhoto({ relative_path: "p.jpg", filename: "p.jpg" });

beforeEach(() => {
  _clearTagInfoCache();
});

afterEach(() => {
  cleanup();
  _clearTagInfoCache();
});

describe("DetailsPane datatype badges", () => {
  it("string schema + string value, no draft → schema only", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    render(<DetailsPane photo={photo} metadata={{ "XMP-dc:Description": "hi" } as Record<string, Variant>} />);
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "S");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("string schema + number value → schema + value", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    render(<DetailsPane photo={photo} metadata={{ "XMP-dc:Description": 42 } as Record<string, Variant>} />);
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "S");
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "N");
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("string schema + string value + string draft → schema only", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    const typed: Record<string, DraftEdit> = {
      "XMP-dc:Description": { value: "bar", intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-dc:Description": "foo" } as Record<string, Variant>}
        draftEdits={{ "XMP-dc:Description": "bar" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toBeInTheDocument();
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("string schema + string value + number draft → schema + draft", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    const typed: Record<string, DraftEdit> = {
      "XMP-dc:Description": { value: 42, intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-dc:Description": "foo" } as Record<string, Variant>}
        draftEdits={{ "XMP-dc:Description": "42" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "S");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-draft")).toHaveAttribute("data-code", "N");
  });

  it("string schema + number value + number draft (draft matches value, both ≠ schema) → schema + value + draft", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    const typed: Record<string, DraftEdit> = {
      "XMP-dc:Description": { value: 7, intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-dc:Description": 42 } as Record<string, Variant>}
        draftEdits={{ "XMP-dc:Description": "7" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toBeInTheDocument();
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "N");
    expect(within(row).getByTestId("datatype-badge-draft")).toHaveAttribute("data-code", "N");
  });

  it("integer schema + numeric value → schema only (N≡I)", () => {
    _setTagInfoCacheEntry(
      "ExifIFD:ISO",
      tagInfo("ExifIFD", "ISO", { kind: "Integer", data: { min: null, max: null } }),
    );
    render(<DetailsPane photo={photo} metadata={{ "ExifIFD:ISO": 100 } as Record<string, Variant>} />);
    const row = findRow("ExifIFD:ISO");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "I");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
  });

  it("integer schema + string value → schema + value", () => {
    _setTagInfoCacheEntry(
      "ExifIFD:ISO",
      tagInfo("ExifIFD", "ISO", { kind: "Integer", data: { min: null, max: null } }),
    );
    render(<DetailsPane photo={photo} metadata={{ "ExifIFD:ISO": "100" } as Record<string, Variant>} />);
    const row = findRow("ExifIFD:ISO");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "I");
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "S");
  });

  it("bag schema + list value → schema only", () => {
    _setTagInfoCacheEntry(
      "XMP-dc:Subject",
      tagInfo("XMP-dc", "Subject", { kind: "Bag", data: { kind: "Text" } }),
    );
    render(<DetailsPane photo={photo} metadata={{ "XMP-dc:Subject": ["a", "b"] } as Record<string, Variant>} />);
    const row = findRow("XMP-dc:Subject");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "[B]");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
  });

  it("bag schema + scalar value → schema + value", () => {
    _setTagInfoCacheEntry(
      "XMP-dc:Subject",
      tagInfo("XMP-dc", "Subject", { kind: "Bag", data: { kind: "Text" } }),
    );
    render(<DetailsPane photo={photo} metadata={{ "XMP-dc:Subject": "a" } as Record<string, Variant>} />);
    const row = findRow("XMP-dc:Subject");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "[B]");
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "S");
  });

  it("bag schema + list value + string draft → schema + draft", () => {
    _setTagInfoCacheEntry(
      "XMP-dc:Subject",
      tagInfo("XMP-dc", "Subject", { kind: "Bag", data: { kind: "Text" } }),
    );
    const typed: Record<string, DraftEdit> = {
      "XMP-dc:Subject": { value: "x", intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-dc:Subject": ["a"] } as Record<string, Variant>}
        draftEdits={{ "XMP-dc:Subject": "x" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-dc:Subject");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "[B]");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-draft")).toHaveAttribute("data-code", "S");
  });

  it("unknown tag → no schema badge but value badge still shown (informational)", () => {
    _setTagInfoCacheEntry("Made-Up:Thing", null);
    render(<DetailsPane photo={photo} metadata={{ "Made-Up:Thing": "x" } as Record<string, Variant>} />);
    const row = findRow("Made-Up:Thing");
    expect(within(row).queryByTestId("datatype-badge-schema")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "S");
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("unknown tag + matching-type draft → value badge only", () => {
    _setTagInfoCacheEntry("Made-Up:Thing", null);
    const typed: Record<string, DraftEdit> = {
      "Made-Up:Thing": { value: "y", intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "Made-Up:Thing": "x" } as Record<string, Variant>}
        draftEdits={{ "Made-Up:Thing": "y" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("Made-Up:Thing");
    expect(within(row).queryByTestId("datatype-badge-schema")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "S");
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("unknown tag + diverging draft → value + draft badges", () => {
    _setTagInfoCacheEntry("Made-Up:Thing", null);
    const typed: Record<string, DraftEdit> = {
      "Made-Up:Thing": { value: 42, intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "Made-Up:Thing": "x" } as Record<string, Variant>}
        draftEdits={{ "Made-Up:Thing": "42" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("Made-Up:Thing");
    expect(within(row).queryByTestId("datatype-badge-schema")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "S");
    expect(within(row).getByTestId("datatype-badge-draft")).toHaveAttribute("data-code", "N");
  });

  it("unknown tag, draft-only property → draft badge shown", () => {
    _setTagInfoCacheEntry("Made-Up:Thing", null);
    const typed: Record<string, DraftEdit> = {
      "Made-Up:Thing": { value: "new", intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{} as Record<string, Variant>}
        draftEdits={{ "Made-Up:Thing": "new" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("Made-Up:Thing");
    expect(within(row).queryByTestId("datatype-badge-schema")).toBeNull();
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-draft")).toHaveAttribute("data-code", "S");
  });

  it("delete-intent draft on string schema → schema only (delete suppressed)", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    const typed: Record<string, DraftEdit> = {
      "XMP-dc:Description": { value: null, intent: "Delete" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-dc:Description": "foo" } as Record<string, Variant>}
        draftEdits={{ "XMP-dc:Description": null }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toBeInTheDocument();
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("draft-only property with matching schema draft → schema only", () => {
    _setTagInfoCacheEntry("XMP-dc:Description", tagInfo("XMP-dc", "Description", { kind: "Text" }));
    const typed: Record<string, DraftEdit> = {
      "XMP-dc:Description": { value: "new", intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{} as Record<string, Variant>}
        draftEdits={{ "XMP-dc:Description": "new" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-dc:Description");
    expect(within(row).getByTestId("datatype-badge-schema")).toBeInTheDocument();
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).queryByTestId("datatype-badge-draft")).toBeNull();
  });

  it("boolean schema + boolean value → schema only", () => {
    _setTagInfoCacheEntry("XMP-x:Flag", tagInfo("XMP-x", "Flag", { kind: "Boolean" }));
    render(<DetailsPane photo={photo} metadata={{ "XMP-x:Flag": true } as Record<string, Variant>} />);
    const row = findRow("XMP-x:Flag");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "B");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
  });

  it("real schema + numeric value + string draft → schema + draft", () => {
    _setTagInfoCacheEntry("XMP-x:Aperture", tagInfo("XMP-x", "Aperture", { kind: "Real" }));
    const typed: Record<string, DraftEdit> = {
      "XMP-x:Aperture": { value: "1.5", intent: "Set" },
    };
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-x:Aperture": 1.5 } as Record<string, Variant>}
        draftEdits={{ "XMP-x:Aperture": "1.5" }}
        typedDraftEdits={typed}
      />,
    );
    const row = findRow("XMP-x:Aperture");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute("data-code", "R");
    expect(within(row).queryByTestId("datatype-badge-value")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-draft")).toHaveAttribute("data-code", "S");
  });

  it("read-only schema → value cell gets details-value--readonly class", () => {
    _setTagInfoCacheEntry(
      "IFD0:Make",
      tagInfo("IFD0", "Make", { kind: "Text" }, /*writable*/ false),
    );
    render(<DetailsPane photo={photo} metadata={{ "IFD0:Make": "Canon" } as Record<string, Variant>} />);
    const row = findRow("IFD0:Make");
    const cell = row.querySelector("td.details-value") as HTMLElement;
    expect(cell.classList.contains("details-value--readonly")).toBe(true);
    expect(cell.getAttribute("data-readonly")).toBe("true");
  });

  it("writable schema → value cell omits read-only class", () => {
    _setTagInfoCacheEntry(
      "XMP-dc:Description",
      tagInfo("XMP-dc", "Description", { kind: "Text" }, /*writable*/ true),
    );
    render(<DetailsPane photo={photo} metadata={{ "XMP-dc:Description": "hi" } as Record<string, Variant>} />);
    const row = findRow("XMP-dc:Description");
    const cell = row.querySelector("td.details-value") as HTMLElement;
    expect(cell.classList.contains("details-value--readonly")).toBe(false);
    expect(cell.getAttribute("data-readonly")).toBeNull();
  });

  it("unknown tag → value cell stays editable-looking (no read-only class)", () => {
    _setTagInfoCacheEntry("Made-Up:Thing", null);
    render(<DetailsPane photo={photo} metadata={{ "Made-Up:Thing": "x" } as Record<string, Variant>} />);
    const row = findRow("Made-Up:Thing");
    const cell = row.querySelector("td.details-value") as HTMLElement;
    expect(cell.classList.contains("details-value--readonly")).toBe(false);
  });

  it("OS section rows never render a schema badge", () => {
    render(<DetailsPane photo={photo} metadata={{}} />);
    const os = screen.getByTestId("details-section-os");
    expect(within(os).queryByTestId("datatype-badge-schema")).toBeNull();
    expect(within(os).queryByTestId("datatype-badge-value")).toBeNull();
  });

  it("schema kind Unknown is treated as no-schema (no schema badge, value badge still shown)", () => {
    _setTagInfoCacheEntry("File:FileType", tagInfo("File", "FileType", { kind: "Unknown" }));
    render(<DetailsPane photo={photo} metadata={{ "File:FileType": "JPEG" } as Record<string, Variant>} />);
    const row = findRow("File:FileType");
    expect(within(row).queryByTestId("datatype-badge-schema")).toBeNull();
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute("data-code", "S");
  });

  it("OS section value cells are always rendered read-only", () => {
    render(<DetailsPane photo={photo} metadata={{}} />);
    const os = screen.getByTestId("details-section-os");
    const cells = os.querySelectorAll("td.details-value");
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of Array.from(cells)) {
      expect(cell.classList.contains("details-value--readonly")).toBe(true);
      expect(cell.getAttribute("data-readonly")).toBe("true");
    }
  });
});

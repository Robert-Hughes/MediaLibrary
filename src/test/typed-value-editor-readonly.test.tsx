// TypedValueEditor read-only routing tests.
//
// Regression coverage for the per-tag Save gate: when the schema reports
// `writable: false` for a tag, the editor must still open (so the user can
// view the value) but the Save button is disabled and the meta-hint banner
// is rendered in warning style with the "read-only" explainer text.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { TypedValueEditor } from "../components/editors/TypedValueEditor";
import { _clearTagInfoCache, _setTagInfoCacheEntry } from "../hooks/useTagInfo";

// useTagInfo calls Tauri's invoke under the hood for any uncached key.
// We seed the cache for the keys the tests care about.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

beforeEach(() => {
  cleanup();
  _clearTagInfoCache();
  // Seed GPS tags and other tags that expect fallback/missing schema to null
  const fallbackTags = [
    "GPS:GPSLatitude",
    "GPS:GPSLongitude",
    "GPS:GPSLatitudeRef",
    "GPS:GPSLongitudeRef",
    "XMP-custom:MissingDate",
  ];
  for (const tag of fallbackTags) {
    _setTagInfoCacheEntry(tag, null);
  }
});

describe("TypedValueEditor read-only enforcement", () => {
  it("disables Save and marks the banner read-only for a writable=false tag", async () => {
    _setTagInfoCacheEntry("EXIF:ExifVersion", {
      group: "EXIF",
      name: "ExifVersion",
      writable: false,
      kind: { kind: "Text" },
      description: "EXIF spec version, set by the camera firmware",
    });
    const onSaveMetadata = vi.fn();
    render(
      <TypedValueEditor
        propertyKey="EXIF:ExifVersion"
        initialMetadataValue={{ kind: "Text", value: "0231" }}
        onSaveMetadata={onSaveMetadata}
        onCancel={() => {}}
      />,
    );
    // Banner shows read-only warning state.
    await waitFor(() => {
      const hint = screen.getByTestId("editor-meta-hint");
      expect(hint).toHaveAttribute("data-readonly", "true");
      expect(hint).toHaveTextContent("read-only");
    });
    // Save button is disabled with the schema-readonly tooltip.
    // (Tag routes through the plain text fallback because kind=Text.)
    const dialog = screen.getByRole("button", { name: /save/i });
    expect(dialog).toBeDisabled();
    expect(dialog).toHaveAttribute(
      "title",
      "Tag is read-only per ExifTool schema",
    );
    fireEvent.click(dialog);
    expect(onSaveMetadata).not.toHaveBeenCalled();
  });

  it("leaves Save enabled and the banner non-warning for a writable tag", async () => {
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey="XMP-dc:Title"
        initialMetadataValue={{ kind: "Text", value: "hello" }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("editor-meta-hint")).toHaveAttribute(
        "data-readonly",
        "false",
      );
    });
    const save = screen.getByRole("button", { name: /save/i });
    expect(save).not.toBeDisabled();
  });

  it("disables Save in the richer editor branches too (NumericEditor)", async () => {
    _setTagInfoCacheEntry("EXIF:Orientation", {
      group: "EXIF",
      name: "Orientation",
      writable: false,
      kind: { kind: "Integer", data: { min: 1, max: 8 } },
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey="EXIF:Orientation"
        initialMetadataValue={{ kind: "Integer", value: 1 }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );
    await waitFor(() => {
      const save = screen.getByTestId(
        "numeric-editor-save",
      ) as HTMLButtonElement;
      expect(save).toBeDisabled();
    });
  });
});

describe("TypedValueEditor temporal routing", () => {
  it.each([
    ["IPTC:DateCreated", { kind: "Date" } as const, "date"],
    ["IPTC:TimeCreated", { kind: "Time" } as const, "time"],
    ["ExifIFD:DateTimeOriginal", { kind: "DateTime" } as const, "datetime"],
  ])("routes %s to the %s temporal editor", async (key, kind, mode) => {
    _setTagInfoCacheEntry(key, {
      group: key.split(":")[0],
      name: key.split(":")[1],
      writable: true,
      kind,
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey={key}
        initialMetadataValue={
          mode === "date"
            ? { kind: "Date", value: { year: 2026, month: 5, day: 15 } }
            : mode === "time"
              ? {
                  kind: "Time",
                  value: {
                    hour: 10,
                    minute: 30,
                    second: 0,
                    subsecond: null,
                    offset: { sign: "Plus", hours: 1, minutes: 0 },
                  },
                }
              : {
                  kind: "DateTime",
                  value: {
                    date: { year: 2026, month: 5, day: 15 },
                    time: {
                      hour: 10,
                      minute: 30,
                      second: 0,
                      subsecond: null,
                      offset: null,
                    },
                  },
                }
        }
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("datetime-editor-input")).toHaveAttribute(
        "data-temporal-mode",
        mode,
      );
    });
  });

  it("keeps a date-like Text tag in the text editor", async () => {
    _setTagInfoCacheEntry("XMP-custom:DateishText", {
      group: "XMP-custom",
      name: "DateishText",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey="XMP-custom:DateishText"
        initialMetadataValue={{
          kind: "Text",
          value: "2026:05:15 10:30:00",
        }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("value-edit-input")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("datetime-editor-input")).toBeNull();
  });

  it("keeps a date-like Unknown tag in the unknown text editor", async () => {
    _setTagInfoCacheEntry("XMP-custom:UnknownDate", {
      group: "XMP-custom",
      name: "UnknownDate",
      writable: true,
      kind: { kind: "Unknown" },
      description: null,
    });
    render(
      <TypedValueEditor
        propertyKey="XMP-custom:UnknownDate"
        initialMetadataValue={{
          kind: "Text",
          value: "2026:05:15 10:30:00",
        }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("unknown-editor-raw-value"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("datetime-editor-input")).toBeNull();
  });

  it("keeps a missing-schema date-like tag in the text fallback", async () => {
    render(
      <TypedValueEditor
        propertyKey="XMP-custom:MissingDate"
        initialMetadataValue={{
          kind: "Text",
          value: "2026:05:15 10:30:00",
        }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("value-edit-input")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("datetime-editor-input")).toBeNull();
  });
});

describe("TypedValueEditor GPS routing", () => {
  it("opens GpsEditor and prefills canonical Real GPS metadata", () => {
    render(
      <TypedValueEditor
        propertyKey="GPS:GPSLatitude"
        metadataForFile={{
          "GPS:GPSLatitude": { kind: "Real", value: 52.2037391662611 },
          "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
          "GPS:GPSLongitude": { kind: "Real", value: 0.123724997044444 },
          "GPS:GPSLongitudeRef": { kind: "Text", value: "E" },
        }}
        onSaveMetadata={() => {}}
        onSaveMetadataBatch={() => {}}
        onCancel={() => {}}
        editorMode="gps"
      />,
    );

    expect(screen.getByTestId("gps-editor-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("gps-editor-lat-input")).toHaveValue(
      52.2037391662611,
    );
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(
      0.123724997044444,
    );
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("N");
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("E");
  });

  it("prefills GpsEditor from stale one-item List<Rational> GPS metadata", () => {
    render(
      <TypedValueEditor
        propertyKey="GPS:GPSLatitude"
        metadataForFile={{
          "GPS:GPSLatitude": {
            kind: "List",
            value: {
              list_kind: "Bag",
              items: [
                {
                  kind: "Rational",
                  value: {
                    numerator: 522037391662611,
                    denominator: 10000000000000,
                  },
                },
              ],
            },
          },
          "GPS:GPSLatitudeRef": { kind: "Text", value: "N" },
          "GPS:GPSLongitude": { kind: "Real", value: 0.123724997044444 },
          "GPS:GPSLongitudeRef": { kind: "Text", value: "E" },
        }}
        onSaveMetadata={() => {}}
        onSaveMetadataBatch={() => {}}
        onCancel={() => {}}
        editorMode="gps"
      />,
    );

    expect(screen.getByTestId("gps-editor-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("gps-editor-lat-input")).toHaveValue(
      52.2037391662611,
    );
  });
});

describe("TypedValueEditor semantic save callbacks", () => {
  it("plain text editor output is a MetadataDraftEdit", async () => {
    _setTagInfoCacheEntry("XMP-dc:Title", {
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const onSaveMetadata = vi.fn();

    render(
      <TypedValueEditor
        propertyKey="XMP-dc:Title"
        initialMetadataValue={{ kind: "Text", value: "old" }}
        onSaveMetadata={onSaveMetadata}
        onCancel={() => {}}
      />,
    );

    const input = await screen.findByTestId("value-edit-input");
    fireEvent.change(input, { target: { value: "new title" } });
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    expect(onSaveMetadata).toHaveBeenCalledWith({
      value: { kind: "Text", value: "new title" },
      intent: "Set",
    });
  });
});

describe("TypedValueEditor nested schema routing", () => {
  it("opens a Bag<Enum> item with its parent enum schema", async () => {
    _setTagInfoCacheEntry("GPS:GPSLatitudeRef", {
      group: "GPS",
      name: "GPSLatitudeRef",
      writable: true,
      kind: {
        kind: "Bag",
        data: {
          kind: "Enum",
          data: {
            repr: "String",
            options: [
              { code: "N", label: "North" },
              { code: "S", label: "South" },
            ],
          },
        },
      },
      description: null,
    });

    render(
      <TypedValueEditor
        propertyKey="GPS:GPSLatitudeRef"
        initialMetadataValue={{
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [{ kind: "Text", value: "N" }],
          },
        }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("nested-list-editor-edit"));

    expect(await screen.findByTestId("enum-editor-select")).toHaveValue("N");
    const hint = screen.getByTestId("editor-meta-hint");
    expect(hint).toHaveTextContent("Enum (2 options)");
    expect(hint).toHaveTextContent("From parent schema");
    expect(hint).not.toHaveTextContent("Not in ExifTool's writable schema");
  });

  it("routes a known struct field through its field schema", async () => {
    _setTagInfoCacheEntry("XMP-test:Record", {
      group: "XMP-test",
      name: "Record",
      writable: true,
      kind: {
        kind: "Struct",
        data: {
          Mode: {
            kind: "Enum",
            data: {
              repr: "String",
              options: [
                { code: "A", label: "Automatic" },
                { code: "M", label: "Manual" },
              ],
            },
          },
        },
      },
      description: null,
    });

    render(
      <TypedValueEditor
        propertyKey="XMP-test:Record"
        initialMetadataValue={{
          kind: "Struct",
          value: { Mode: { kind: "Text", value: "M" } },
        }}
        onSaveMetadata={() => {}}
        onCancel={() => {}}
      />,
    );

    fireEvent.click(screen.getByTestId("struct-editor-edit-0"));
    expect(await screen.findByTestId("enum-editor-select")).toHaveValue("M");
    expect(screen.getByTestId("editor-meta-hint")).toHaveTextContent(
      "From parent schema",
    );
  });
});

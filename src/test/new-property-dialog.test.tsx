import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewPropertyDialog } from "../components/NewPropertyDialog";
import { _clearTagInfoCache } from "../hooks/useTagInfo";
import {
  _resetWritableSchemaDefinitionsCache,
  _setWritableSchemaDefinitionsCache,
} from "../hooks/useWritableSchemaDefinitions";
import type { TagInfo } from "../types";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => new Promise(() => {})),
}));

const testDefinitions: TagInfo[] = [
  {
    id: { table: "XMP::dc", tag_id: "title" },
    group0: "XMP",
    group: "XMP-dc",
    name: "Title",
    writable: true,
    kind: { kind: "Text" },
    description: "Document Title",
  },
  {
    id: { table: "XMP::dc", tag_id: "description" },
    group0: "XMP",
    group: "XMP-dc",
    name: "Description",
    writable: true,
    kind: { kind: "Text" },
    description: "Document Description",
  },
  {
    id: { table: "Canon::CameraInfo40D", tag_id: "4" },
    group0: "EXIF",
    group: "Canon",
    name: "WhiteBalance",
    writable: true,
    kind: { kind: "Text" },
    description: "WB 40D",
  },
  {
    id: { table: "Canon::CameraInfo5D", tag_id: "4" },
    group0: "EXIF",
    group: "Canon",
    name: "WhiteBalance",
    writable: true,
    kind: { kind: "Text" },
    description: "WB 5D",
  },
  {
    id: { table: "Vorbis::Comment", tag_id: "title" },
    group0: "Vorbis",
    group: "Vorbis",
    name: "Title",
    writable: true,
    kind: { kind: "Text" },
    description: "Audio Title",
  },
  {
    id: { table: "Exif::Main", tag_id: "271", index: 0 },
    group0: "EXIF",
    group: "IFD0",
    name: "Make",
    writable: true,
    kind: { kind: "Text" },
    description: "Manufacturer Index 0",
  },
];

beforeEach(() => {
  cleanup();
  _clearTagInfoCache();
  _resetWritableSchemaDefinitionsCache();
});

describe("NewPropertyDialog exact-ID selection flow", () => {
  it("represents loading state safely", () => {
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("new-property-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("new-property-key")).toBeNull();
  });

  it("shows an instruction instead of rendering definitions for a blank query", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    expect(screen.getByTestId("new-property-key")).toBeInTheDocument();

    expect(
      screen.getByText("Type to search writable properties."),
    ).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^schema-option-/)).toHaveLength(0);
  });

  it("uses theme-token classes for the schema selector and its inputs", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    const search = screen.getByTestId("new-property-key");
    expect(search).toHaveClass("dialog-input");
    const results = screen.getByText(
      "Type to search writable properties.",
    ).parentElement;
    expect(results).toHaveClass("dialog-results-list");

    fireEvent.change(search, { target: { value: "Title" } });

    const option = screen.getByTestId(
      `schema-option-${schemaDefinitionIdToken(testDefinitions[0].id)}`,
    );
    expect(option).toHaveClass("dialog-results-option");
    expect(option).not.toHaveAttribute(
      "style",
      expect.stringMatching(/#|--bg-|--fg-/),
    );

    fireEvent.click(option);
    expect(option).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("new-property-destination-group")).toHaveClass(
      "dialog-input",
    );
  });

  it("filters search matches by friendly name", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const input = screen.getByTestId("new-property-key") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "XMP-dc" } });

    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    const descToken = schemaDefinitionIdToken(testDefinitions[1].id);
    const canonToken = schemaDefinitionIdToken(testDefinitions[2].id);

    expect(
      screen.getByTestId(`schema-option-${titleToken}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`schema-option-${descToken}`),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`schema-option-${canonToken}`)).toBeNull();
  });

  it("trims surrounding whitespace when filtering", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByLabelText("Search Writable Properties"), {
      target: { value: "  Title  " },
    });

    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    expect(
      screen.getByTestId(`schema-option-${titleToken}`),
    ).toBeInTheDocument();
  });

  it("filters search matches by description", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const input = screen.getByTestId("new-property-key") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Document Description" } });

    const descToken = schemaDefinitionIdToken(testDefinitions[1].id);
    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);

    expect(
      screen.getByTestId(`schema-option-${descToken}`),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`schema-option-${titleToken}`)).toBeNull();
  });

  it("filters search matches by table and tag ID", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const input = screen.getByTestId("new-property-key") as HTMLInputElement;

    // Search by table
    fireEvent.change(input, { target: { value: "CameraInfo40D" } });

    const canon40DToken = schemaDefinitionIdToken(testDefinitions[2].id);
    const canon5DToken = schemaDefinitionIdToken(testDefinitions[3].id);

    expect(
      screen.getByTestId(`schema-option-${canon40DToken}`),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`schema-option-${canon5DToken}`)).toBeNull();
  });

  it("typing alone does not enable Next", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    const input = screen.getByTestId("new-property-key") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "Title" } });
    expect(screen.getByTestId("new-property-next")).toBeDisabled();
  });

  it("clicking one result enables Next and returns the complete default target", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Title" },
    });

    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    const option = screen.getByTestId(`schema-option-${titleToken}`);

    await user.click(option);
    expect(screen.getByTestId("new-property-next")).not.toBeDisabled();

    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith({
      kind: "NewProperty",
      schema_id: testDefinitions[0].id,
      write_target: {
        group1: testDefinitions[0].group,
        group7: `ID-${testDefinitions[0].id.tag_id}`,
        tag_name: testDefinitions[0].name,
      },
    });
  });

  it("pressing Enter submits only after an explicit selection", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);
    const input = screen.getByTestId("new-property-key") as HTMLInputElement;

    // Press enter before selection -> nothing
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();

    // Select then enter
    fireEvent.change(input, { target: { value: "Title" } });
    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    await user.click(screen.getByTestId(`schema-option-${titleToken}`));

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ schema_id: testDefinitions[0].id }),
    );
  });

  it("accepts an unknown valid destination and returns the schema-locked selector", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);

    await user.type(screen.getByTestId("new-property-key"), "Title");
    await user.click(
      screen.getByTestId(
        `schema-option-${schemaDefinitionIdToken(testDefinitions[0].id)}`,
      ),
    );
    const destination = screen.getByTestId("new-property-destination-group");
    await user.clear(destination);
    await user.type(destination, "Custom-IFD");
    expect(screen.getByTestId("new-property-write-selector")).toHaveTextContent(
      "1Custom-IFD:7ID-title:Title",
    );
    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        write_target: {
          group1: "Custom-IFD",
          group7: "ID-title",
          tag_name: "Title",
        },
      }),
    );
  });

  it("rejects family prefixes and selector syntax with a precise message", async () => {
    const user = userEvent.setup();
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    await user.type(screen.getByTestId("new-property-key"), "Title");
    await user.click(
      screen.getByTestId(
        `schema-option-${schemaDefinitionIdToken(testDefinitions[0].id)}`,
      ),
    );
    const destination = screen.getByTestId("new-property-destination-group");
    await user.clear(destination);
    await user.type(destination, "1IFD0");
    expect(
      screen.getByTestId("new-property-destination-error"),
    ).toHaveTextContent("numeric family prefix");
    expect(screen.getByTestId("new-property-next")).toBeDisabled();
  });

  it("locks the schema while allowing an existing destination to change", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);
    const info = testDefinitions[0];
    render(
      <NewPropertyDialog
        onSave={onSave}
        onCancel={() => {}}
        initialTarget={{
          kind: "NewProperty",
          schema_id: info.id,
          write_target: {
            group1: "Saved-Custom",
            group7: `ID-${info.id.tag_id}`,
            tag_name: info.name,
          },
        }}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Edit Property Destination" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("new-property-next")).toHaveTextContent(
      "Save destination",
    );
    const schema = await screen.findByLabelText("Property schema");
    expect(schema).toHaveValue(`${info.group}:${info.name}`);
    expect(schema).toHaveAttribute("readonly");
    expect(
      screen
        .getByTestId(
          `schema-option-${schemaDefinitionIdToken(testDefinitions[0].id)}`,
        )
        .closest(".dialog-results-list"),
    ).not.toBeVisible();
    const destination = screen.getByTestId("new-property-destination-group");
    expect(destination).toHaveFocus();
    expect(destination).toBeEnabled();
    await user.clear(destination);
    await user.type(destination, "Edited-Custom");
    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith({
      kind: "NewProperty",
      schema_id: info.id,
      write_target: {
        group1: "Edited-Custom",
        group7: `ID-${info.id.tag_id}`,
        tag_name: info.name,
      },
    });
    const options = Array.from(
      document.querySelectorAll<HTMLDataListElement>(
        "#new-property-group-suggestions option",
      ),
    ).map((option) => option.getAttribute("value"));
    expect(options[0]).toBe(info.group);
    expect(new Set(options).size).toBe(options.length);
  });

  it("keeps schema selection enabled when adding a property", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    expect(
      screen.getByLabelText("Search Writable Properties"),
    ).not.toHaveAttribute("readonly");
  });

  it("selects a focused search result with the keyboard", async () => {
    const user = userEvent.setup();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    await user.type(screen.getByTestId("new-property-key"), "Title");

    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    const option = screen.getByTestId(`schema-option-${titleToken}`);
    option.focus();
    expect(option).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(option).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("new-property-next")).toBeEnabled();
  });

  it("selects a focused search result with Space", async () => {
    const user = userEvent.setup();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);
    await user.type(screen.getByTestId("new-property-key"), "Title");

    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    const option = screen.getByTestId(`schema-option-${titleToken}`);
    option.focus();

    await user.keyboard(" ");
    expect(option).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("new-property-next")).toBeEnabled();
  });

  it("renders two same-friendly-name definitions separately and displays enough context to distinguish them", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Canon:WhiteBalance" },
    });

    const canon40DToken = schemaDefinitionIdToken(testDefinitions[2].id);
    const canon5DToken = schemaDefinitionIdToken(testDefinitions[3].id);

    const opt40D = screen.getByTestId(`schema-option-${canon40DToken}`);
    const opt5D = screen.getByTestId(`schema-option-${canon5DToken}`);

    expect(opt40D).toBeInTheDocument();
    expect(opt5D).toBeInTheDocument();

    // Check distinct context
    expect(opt40D).toHaveTextContent("Canon::CameraInfo40D");
    expect(opt40D).toHaveTextContent("WB 40D");
    expect(opt5D).toHaveTextContent("Canon::CameraInfo5D");
    expect(opt5D).toHaveTextContent("WB 5D");
  });

  it("selecting one collision returns only that ID", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    render(<NewPropertyDialog onSave={onSave} onCancel={() => {}} />);

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Canon:WhiteBalance" },
    });

    const canon5DToken = schemaDefinitionIdToken(testDefinitions[3].id);
    await user.click(screen.getByTestId(`schema-option-${canon5DToken}`));

    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ schema_id: testDefinitions[3].id }),
    );
  });

  it("allows a same-schema occurrence at another proven selector and blocks its exact selector", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    render(
      <NewPropertyDialog
        onSave={onSave}
        onCancel={() => {}}
        existingOccurrences={[
          {
            id: {
              document: null,
              path: "JPEG-APP1-MakerNotes",
              runtime_tag_id: "4",
              tag_id_scope: {
                table: testDefinitions[2].id.table,
                tag_id: "4",
                index: null,
              },
              copy: 0,
            },
            schema_id: testDefinitions[2].id,
            value: { kind: "Text", value: "Auto" },
            tag_info: testDefinitions[2],
            observed_selector: {
              group1: "MakerNotes",
              group7: "ID-4",
              tag_name: "WhiteBalance",
            },
            write_target: {
              group1: "MakerNotes",
              group7: "ID-4",
              tag_name: "WhiteBalance",
            },
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Canon:WhiteBalance" },
    });

    const canon40DToken = schemaDefinitionIdToken(testDefinitions[2].id);
    await user.click(screen.getByTestId(`schema-option-${canon40DToken}`));
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).not.toBeDisabled();

    await user.clear(screen.getByTestId("new-property-destination-group"));
    await user.type(
      screen.getByTestId("new-property-destination-group"),
      "MakerNotes",
    );
    expect(screen.getByTestId("new-property-duplicate-warning")).toBeVisible();
    expect(screen.getByTestId("new-property-next")).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("blocks a cross-schema observed selector even without a write target and preserves family-7 case", async () => {
    const occurrence = {
      id: {
        document: null,
        path: "XMP",
        runtime_tag_id: "title",
        tag_id_scope: {
          table: testDefinitions[1].id.table,
          tag_id: testDefinitions[1].id.tag_id,
          index: null,
        },
        copy: 0,
      },
      schema_id: testDefinitions[1].id,
      value: { kind: "Text" as const, value: "occupied" },
      tag_info: testDefinitions[1],
      observed_selector: {
        group1: "xmp-DC",
        group7: "ID-title",
        tag_name: "title",
      },
      write_target: null,
    };
    _setWritableSchemaDefinitionsCache(testDefinitions);
    const view = render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        existingOccurrences={[occurrence]}
      />,
    );
    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Document Title" },
    });
    await userEvent.click(
      screen.getByTestId(
        `schema-option-${schemaDefinitionIdToken(testDefinitions[0].id)}`,
      ),
    );
    expect(
      screen.getByTestId("new-property-duplicate-warning"),
    ).toHaveTextContent("complete ExifTool destination already present");

    view.rerender(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        existingOccurrences={[
          {
            ...occurrence,
            observed_selector: {
              ...occurrence.observed_selector,
              group7: "ID-Title",
            },
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).toBeEnabled();
  });

  it("shows and distinguishes index: Some(0) from omitted index", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Text" },
    });

    const omittedToken = schemaDefinitionIdToken(testDefinitions[0].id);
    const zeroToken = schemaDefinitionIdToken(testDefinitions[5].id);

    const optOmitted = screen.getByTestId(`schema-option-${omittedToken}`);
    const optZero = screen.getByTestId(`schema-option-${zeroToken}`);

    expect(optOmitted).not.toHaveTextContent("Index");
    expect(optZero).toHaveTextContent("Index 0");
  });

  it("filters suggestions by filename applicability using TagInfo.group", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(
      <NewPropertyDialog
        onSave={() => {}}
        onCancel={() => {}}
        filename="file.jpg"
      />,
    );

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Title" },
    });

    const titleToken = schemaDefinitionIdToken(testDefinitions[0].id);
    const audioToken = schemaDefinitionIdToken(testDefinitions[4].id);

    expect(
      screen.getByTestId(`schema-option-${titleToken}`),
    ).toBeInTheDocument();
    expect(screen.queryByTestId(`schema-option-${audioToken}`)).toBeNull();
  });

  it("filters writable Binary and Unknown definitions from malformed caches", () => {
    const supported = testDefinitions[0];
    const binary: TagInfo = {
      id: { table: "Test::Main", tag_id: "binary" },
      group: "XMP-test",
      name: "UnsupportedBinary",
      writable: true,
      kind: { kind: "Binary" },
      description: null,
    };
    const unknown: TagInfo = {
      id: { table: "Test::Main", tag_id: "unknown" },
      group: "XMP-test",
      name: "UnsupportedUnknown",
      writable: true,
      kind: { kind: "Unknown" },
      description: null,
    };
    _setWritableSchemaDefinitionsCache([supported, binary, unknown]);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Unsupported" },
    });

    expect(
      screen.queryByTestId(
        `schema-option-${schemaDefinitionIdToken(binary.id)}`,
      ),
    ).toBeNull();
    expect(
      screen.queryByTestId(
        `schema-option-${schemaDefinitionIdToken(unknown.id)}`,
      ),
    ).toBeNull();
    expect(
      screen.getByText("No matching writable schema definitions found."),
    ).toBeInTheDocument();
  });

  it("shows no raw text/unknown property warnings", () => {
    _setWritableSchemaDefinitionsCache(testDefinitions);
    render(<NewPropertyDialog onSave={() => {}} onCancel={() => {}} />);

    expect(screen.queryByTestId("new-property-schema-unknown")).toBeNull();
  });
});

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
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const testDefinitions: TagInfo[] = [
  {
    id: { table: "XMP::dc", tag_id: "title" },
    group: "XMP-dc",
    name: "Title",
    writable: true,
    kind: { kind: "Text" },
    description: "Document Title",
  },
  {
    id: { table: "XMP::dc", tag_id: "description" },
    group: "XMP-dc",
    name: "Description",
    writable: true,
    kind: { kind: "Text" },
    description: "Document Description",
  },
  {
    id: { table: "Canon::CameraInfo40D", tag_id: "4" },
    group: "Canon",
    name: "WhiteBalance",
    writable: true,
    kind: { kind: "Text" },
    description: "WB 40D",
  },
  {
    id: { table: "Canon::CameraInfo5D", tag_id: "4" },
    group: "Canon",
    name: "WhiteBalance",
    writable: true,
    kind: { kind: "Text" },
    description: "WB 5D",
  },
  {
    id: { table: "Vorbis::Comment", tag_id: "title" },
    group: "Vorbis",
    name: "Title",
    writable: true,
    kind: { kind: "Text" },
    description: "Audio Title",
  },
  {
    id: { table: "Exif::Main", tag_id: "271", index: 0 },
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

  it("clicking one result enables Next and onSave returns the selected ID", async () => {
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
    expect(onSave).toHaveBeenCalledWith(testDefinitions[0].id);
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
    expect(onSave).toHaveBeenCalledWith(testDefinitions[0].id);
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
    expect(onSave).toHaveBeenCalledWith(testDefinitions[3].id);
  });

  it("exact duplicate detection blocks only the matching ID and keeps sibling selectable", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    _setWritableSchemaDefinitionsCache(testDefinitions);

    const existingIds = [testDefinitions[2].id]; // 40D is duplicate, 5D is not

    render(
      <NewPropertyDialog
        onSave={onSave}
        onCancel={() => {}}
        existingIds={existingIds}
      />,
    );

    fireEvent.change(screen.getByTestId("new-property-key"), {
      target: { value: "Canon:WhiteBalance" },
    });

    const canon40DToken = schemaDefinitionIdToken(testDefinitions[2].id);
    const canon5DToken = schemaDefinitionIdToken(testDefinitions[3].id);

    // Select 40D (duplicate)
    await user.click(screen.getByTestId(`schema-option-${canon40DToken}`));
    expect(
      screen.getByTestId("new-property-duplicate-warning"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("new-property-next")).toBeDisabled();

    // Select 5D (sibling, not duplicate)
    await user.click(screen.getByTestId(`schema-option-${canon5DToken}`));
    expect(screen.queryByTestId("new-property-duplicate-warning")).toBeNull();
    expect(screen.getByTestId("new-property-next")).not.toBeDisabled();

    await user.click(screen.getByTestId("new-property-next"));
    expect(onSave).toHaveBeenCalledWith(testDefinitions[3].id);
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
        filename="photo.jpg"
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

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import type {
  MetadataOccurrence,
  MetadataOccurrenceId,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { metadataCollection } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { makePhoto } from "./factories";

const schemaId: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "282",
};
const tagInfo: TagInfo = {
  id: schemaId,
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind: { kind: "Integer", data: { min: null, max: null } },
  description: null,
};
const photo = makePhoto({ relative_path: "collision.jpg" });

function occurrence(
  id: MetadataOccurrenceId,
  value: number,
  group1: string,
  info: TagInfo = tagInfo,
): MetadataOccurrence {
  return {
    id,
    value: { kind: "Integer", value },
    tag_info: info,
    write_target: { group1, tag_name: "XResolution" },
  };
}

const collision: MetadataOccurrence[] = [
  occurrence(
    {
      document: null,
      path: "JPEG-APP1-IFD0",
      tag_id: "282",
      copy: 0,
    },
    300,
    "IFD0",
  ),
  occurrence(
    {
      document: null,
      path: "JPEG-APP1-IFD1",
      tag_id: "282",
      copy: 2,
    },
    72,
    "IFD1",
  ),
];

function renderPane(
  options: {
    metadata?: Parameters<typeof DetailsPane>[0]["metadata"];
    occurrences?: Parameters<typeof DetailsPane>[0]["occurrences"];
    draftEdits?: Parameters<typeof DetailsPane>[0]["draftEdits"];
    typedDraftEdits?: Parameters<typeof DetailsPane>[0]["typedDraftEdits"];
  } = {},
) {
  const callbacks = {
    onSetMetadataDraft: vi.fn(),
    onSetMetadataDraftBatch: vi.fn(),
    onDiscardDraft: vi.fn(),
    onDiscardDraftBatch: vi.fn(),
  };
  render(
    <DetailsPane
      photo={photo}
      metadata={options.metadata ?? {}}
      occurrences={options.occurrences ?? collision}
      draftEdits={options.draftEdits}
      typedDraftEdits={options.typedDraftEdits}
      {...callbacks}
    />,
  );
  return callbacks;
}

describe("DetailsPane additional metadata occurrences", () => {
  it("shows both sides of the original collision with distinct origins and tokens", () => {
    renderPane();
    const section = screen.getByTestId(
      "details-section-additional-occurrences",
    );
    const rows = within(section).getAllByTestId("details-occurrence-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("300");
    expect(rows[0]).toHaveTextContent("IFD0 · JPEG-APP1-IFD0 · primary");
    expect(rows[1]).toHaveTextContent("72");
    expect(rows[1]).toHaveTextContent("IFD1 · JPEG-APP1-IFD1 · Copy2");
    expect(rows[0].dataset.occurrenceToken).not.toBe(
      rows[1].dataset.occurrenceToken,
    );
  });

  it("keeps exact-write-target rows read-only without schema actions", () => {
    const callbacks = renderPane();
    const row = screen.getAllByTestId("details-occurrence-row")[0];
    expect(row).toHaveAttribute("data-readonly", "true");
    fireEvent.contextMenu(row);
    expect(screen.queryByText(/^Edit…$/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Remove$/)).not.toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(callbacks.onSetMetadataDraft).not.toHaveBeenCalled();
    expect(callbacks.onSetMetadataDraftBatch).not.toHaveBeenCalled();
  });

  it("uses the authoritative unique occurrence without duplicating it", () => {
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      occurrences: [occurrence(collision[0].id, 301, "IFD0")],
    });
    const row = screen
      .getByText("XResolution")
      .closest('[data-testid="details-row"]') as HTMLElement;
    expect(row).toHaveTextContent("301");
    expect(row).not.toHaveTextContent("300");
    expect(row).toHaveTextContent("XResolution");
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute(
      "data-code",
      "I",
    );
    expect(
      screen.queryByTestId("details-occurrence-row"),
    ).not.toBeInTheDocument();
    fireEvent.contextMenu(row);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
  });

  it.each(["XResolution", "300", "IFD1", "JPEG-APP1-IFD1", "Copy2", "282"])(
    "searches occurrence text for %s",
    async (query) => {
      renderPane();
      await userEvent.type(screen.getByTestId("details-search-input"), query);
      expect(
        screen.getAllByTestId("details-occurrence-row").length,
      ).toBeGreaterThan(0);
    },
  );

  it("excludes supplemental occurrences from has:edits", async () => {
    renderPane();
    await userEvent.type(
      screen.getByTestId("details-search-input"),
      "has:edits",
    );
    expect(
      screen.queryByTestId("details-section-additional-occurrences"),
    ).not.toBeInTheDocument();
  });

  it("suppresses the empty message only while supplemental rows are visible", () => {
    const { rerender } = render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        occurrences={collision}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );
    expect(
      screen.queryByText("No image metadata available"),
    ).not.toBeInTheDocument();

    rerender(
      <DetailsPane
        photo={photo}
        metadata={{}}
        occurrences={[]}
        onSetMetadataDraftBatch={vi.fn()}
        onDiscardDraftBatch={vi.fn()}
      />,
    );
    expect(screen.getByText("No image metadata available")).toBeInTheDocument();
  });

  it("loading occurrence data does not hide loaded legacy rows", () => {
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      occurrences: "loading",
    });
    expect(screen.getByText("300")).toBeInTheDocument();
    expect(screen.queryByText("Loading metadata…")).not.toBeInTheDocument();
  });

  it("uses embedded schema and runtime datatypes without an async lookup", () => {
    const divergentInfo: TagInfo = {
      ...tagInfo,
      kind: { kind: "Text" },
    };
    renderPane({
      occurrences: [occurrence(collision[0].id, 300, "IFD0", divergentInfo)],
    });
    expect(screen.getByTestId("datatype-badge-schema")).toHaveAttribute(
      "data-code",
      "S",
    );
    expect(screen.getByTestId("datatype-badge-value")).toHaveAttribute(
      "data-code",
      "I",
    );
  });

  it("marks identical multiple occurrences ambiguous and disables schema actions", async () => {
    const identical = [
      occurrence(collision[0].id, 300, "IFD0"),
      occurrence(collision[1].id, 300, "IFD1"),
    ];
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      occurrences: identical,
    });

    const aggregate = screen.getByText("2 occurrences").closest("tr")!;
    expect(aggregate).toHaveAttribute("data-occurrence-resolution", "multiple");
    expect(aggregate).toHaveTextContent("300");
    expect(screen.getAllByTestId("details-occurrence-row")).toHaveLength(2);

    fireEvent.contextMenu(aggregate);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit GPS…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    const heading = aggregate.closest("section")!.querySelector("h3")!;
    fireEvent.contextMenu(heading);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("renders different multiple values only as concrete occurrence rows", () => {
    renderPane({ metadata: {}, occurrences: collision });

    const rows = screen.getAllByTestId("details-occurrence-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("300");
    expect(rows[1]).toHaveTextContent("72");
    expect(rows[0].dataset.occurrenceToken).not.toBe(
      rows[1].dataset.occurrenceToken,
    );
    expect(
      document.querySelector('[data-occurrence-resolution="multiple"]'),
    ).toBeNull();
  });

  it("keeps an ambiguous schema draft only on the aggregate and allows one discard", () => {
    const token = schemaDefinitionIdToken(schemaId);
    const callbacks = renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      draftEdits: { [token]: "301" },
    });

    const aggregate = screen.getByText("2 occurrences").closest("tr")!;
    expect(aggregate.querySelector(".draft-new")).toHaveTextContent("301");
    for (const concrete of screen.getAllByTestId("details-occurrence-row")) {
      expect(concrete.querySelector(".draft-new")).toBeNull();
    }

    fireEvent.contextMenu(aggregate);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(callbacks.onDiscardDraft).toHaveBeenCalledTimes(1);
    expect(callbacks.onDiscardDraft).toHaveBeenCalledWith(schemaId);
  });

  it("excludes ambiguous schemas from group Remove but retains group Discard", async () => {
    const token = schemaDefinitionIdToken(schemaId);
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      draftEdits: { [token]: "301" },
    });
    const aggregate = screen.getByText("2 occurrences").closest("tr")!;
    fireEvent.contextMenu(aggregate.closest("section")!.querySelector("h3")!);

    expect(
      await screen.findByRole("button", {
        name: "Discard 1 Exif::Main edit…",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Remove .*writable/)).toBeNull();
  });

  it("searches ambiguity text and keeps only the aggregate draft for has:edits", async () => {
    const token = schemaDefinitionIdToken(schemaId);
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      draftEdits: { [token]: "301" },
    });
    const search = screen.getByTestId("details-search-input");

    await userEvent.type(search, "multiple occurrences");
    expect(screen.getByText("2 occurrences")).toBeInTheDocument();
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();

    await userEvent.clear(search);
    await userEvent.type(search, "has:edits");
    expect(screen.getByText("2 occurrences")).toBeInTheDocument();
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
  });
});

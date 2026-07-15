import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import type {
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataDraftCollection,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import { metadataCollection } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { makePhoto } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

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
    targetDraftEdits?: Parameters<typeof DetailsPane>[0]["targetDraftEdits"];
  } = {},
) {
  const callbacks = {
    onSetExistingOccurrenceDraft: vi.fn(),
    onRemoveMetadataFieldsV5: vi.fn(),
    onSetGpsTargetDraftBatch: vi.fn(() => true),
    onDiscardDraft: vi.fn(),
    onDiscardDraftBatch: vi.fn(),
  };
  const pane = (paneOptions: typeof options) => (
    <DetailsPane
      photo={photo}
      metadata={paneOptions.metadata ?? {}}
      occurrences={paneOptions.occurrences ?? collision}
      draftEdits={paneOptions.draftEdits}
      typedDraftEdits={paneOptions.typedDraftEdits}
      targetDraftEdits={paneOptions.targetDraftEdits}
      {...callbacks}
    />
  );
  const rendered = render(pane(options));
  return {
    ...callbacks,
    rerenderPane: (nextOptions: typeof options) =>
      rendered.rerender(pane(nextOptions)),
  };
}

function draftCollection(
  edit: MetadataDraftCollection[string]["edit"],
): MetadataDraftCollection {
  return {
    [schemaDefinitionIdToken(schemaId)]: { id: schemaId, edit },
  };
}

beforeEach(() => {
  _clearTagInfoCache();
});

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

  it("offers exact v5 actions for targetable supplemental rows", () => {
    const callbacks = renderPane();
    const row = screen.getAllByTestId("details-occurrence-row")[0];
    expect(row).not.toHaveAttribute("data-readonly");
    fireEvent.contextMenu(row);
    expect(screen.getByText(/^Edit…$/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^Remove$/));
    expect(callbacks.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      collision[0].id,
      { intent: "Delete", value: null },
    );
    expect(callbacks.onRemoveMetadataFieldsV5).not.toHaveBeenCalled();
  });

  it("uses the authoritative unique occurrence in both row and editor without duplicating it", () => {
    _setTagInfoCacheEntry(schemaId, tagInfo);
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
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(301);
  });

  it("displays a legacy Set draft but blocks concrete-occurrence editing", () => {
    _setTagInfoCacheEntry(schemaId, tagInfo);
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      occurrences: [occurrence(collision[0].id, 301, "IFD0")],
      typedDraftEdits: draftCollection({
        intent: "Set",
        value: { kind: "Integer", value: 302 },
      }),
    });

    const row = screen
      .getByText("XResolution")
      .closest('[data-testid="details-row"]') as HTMLElement;
    expect(row).toHaveTextContent("301");
    expect(row.querySelector(".draft-new")).toHaveTextContent("302");
    expect(row).toHaveAttribute(
      "title",
      expect.stringMatching(/legacy draft/i),
    );
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Discard edit" })).toBeVisible();
  });

  it("keeps a missing occurrence row read-only", () => {
    _setTagInfoCacheEntry(schemaId, tagInfo);
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      occurrences: [],
    });

    const row = screen
      .getByText("XResolution")
      .closest('[data-testid="details-row"]') as HTMLElement;
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(row).toHaveAttribute("data-readonly", "true");
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
        onRemoveMetadataFieldsV5={vi.fn()}
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
        onRemoveMetadataFieldsV5={vi.fn()}
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

  it("uses embedded schema for the unique row label, datatype, and writability", () => {
    const divergentInfo: TagInfo = {
      ...tagInfo,
      name: "EmbeddedResolution",
      writable: false,
      kind: { kind: "Text" },
    };
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      occurrences: [occurrence(collision[0].id, 300, "IFD0", divergentInfo)],
    });
    const row = screen
      .getByText("EmbeddedResolution")
      .closest('[data-testid="details-row"]') as HTMLElement;
    expect(within(row).getByTestId("datatype-badge-schema")).toHaveAttribute(
      "data-code",
      "S",
    );
    expect(within(row).getByTestId("datatype-badge-value")).toHaveAttribute(
      "data-code",
      "I",
    );
    expect(row).toHaveAttribute("data-readonly", "true");
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
  });

  it("updates an open row menu from unique to multiple without stale actions", () => {
    const gpsId: SchemaDefinitionId = { table: "GPS::Main", tag_id: "2" };
    const gpsInfo: TagInfo = {
      id: gpsId,
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    };
    const gpsOccurrence = (
      copy: number,
      value: number,
    ): MetadataOccurrence => ({
      id: {
        document: null,
        path: "JPEG-APP1-GPS",
        tag_id: "2",
        copy,
      },
      value: { kind: "Real", value },
      tag_info: gpsInfo,
      write_target: { group1: "GPS", tag_name: "GPSLatitude" },
    });
    const metadata = metadataCollection([
      { id: gpsId, value: { kind: "Real", value: 51.5 } },
    ]);
    const uniqueGpsOccurrence = gpsOccurrence(0, 51.5);
    const target = existingOccurrenceTargetFromOccurrence(uniqueGpsOccurrence);
    if (target.kind !== "targetable") throw new Error(target.reason);
    const targetStore = new TargetDraftEditsStore();
    targetStore.setMetadataTarget(photo.relative_path, target.target, {
      intent: "Set",
      value: { kind: "Real", value: 51.6 },
    });
    const targetDraftEdits = targetStore.getMetadataFile(photo.relative_path);
    const view = renderPane({
      metadata,
      occurrences: [uniqueGpsOccurrence],
      targetDraftEdits,
    });
    const row = screen
      .getByText("GPSLatitude")
      .closest('[data-testid="details-row"]') as HTMLElement;

    fireEvent.contextMenu(row);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit GPS…" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

    view.rerenderPane({
      metadata,
      occurrences: [gpsOccurrence(0, 51.5), gpsOccurrence(1, 51.5)],
      targetDraftEdits,
    });

    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit GPS…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Discard edit" }).length,
    ).toBeGreaterThan(0);
  });

  it("keeps an exact editor on A when its schema becomes multiple", async () => {
    _setTagInfoCacheEntry(schemaId, tagInfo);
    const metadata = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    const view = renderPane({
      metadata,
      occurrences: [occurrence(collision[0].id, 301, "IFD0")],
    });
    const row = screen
      .getByText("XResolution")
      .closest('[data-testid="details-row"]') as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.getByTestId("numeric-editor-overlay")).toBeInTheDocument();

    view.rerenderPane({ metadata, occurrences: collision });

    expect(screen.getByTestId("numeric-editor-overlay")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "302" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      collision[0].id,
      expect.objectContaining({
        intent: "Set",
        value: { kind: "Integer", value: 302 },
      }),
    );
    expect(view.onRemoveMetadataFieldsV5).not.toHaveBeenCalled();

    const ambiguousRow = screen.getByText("2 occurrences").closest("tr")!;
    fireEvent.contextMenu(ambiguousRow);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
  });

  it("refreshes an open editor and row when the unique occurrence is replaced", () => {
    _setTagInfoCacheEntry(schemaId, tagInfo);
    const metadata = metadataCollection([
      { id: schemaId, value: { kind: "Integer", value: 300 } },
    ]);
    const view = renderPane({
      metadata,
      occurrences: [occurrence(collision[0].id, 301, "IFD0")],
    });
    const row = screen
      .getByText("XResolution")
      .closest('[data-testid="details-row"]') as HTMLElement;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(301);

    view.rerenderPane({
      metadata,
      occurrences: [occurrence(collision[0].id, 302, "IFD0")],
    });

    expect(row).toHaveTextContent("302");
    expect(row).not.toHaveTextContent("301");
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(302);
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

  it("keeps an absent ambiguous Delete draft visible and discardable only on the compatibility row", async () => {
    _setTagInfoCacheEntry(schemaId, tagInfo);
    const callbacks = renderPane({
      metadata: {},
      occurrences: collision,
      typedDraftEdits: draftCollection({ intent: "Delete", value: null }),
    });

    const aggregate = await screen.findByText("2 occurrences");
    const compatibilityRow = aggregate.closest("tr")!;
    expect(compatibilityRow).toHaveAttribute(
      "data-occurrence-resolution",
      "multiple",
    );
    expect(compatibilityRow.querySelector(".draft-new")).toHaveTextContent("—");

    const concreteRows = screen.getAllByTestId("details-occurrence-row");
    expect(concreteRows).toHaveLength(2);
    for (const concrete of concreteRows) {
      expect(concrete.querySelector(".draft-new")).toBeNull();
      expect(concrete.querySelector(".draft-original")).toBeNull();
    }

    fireEvent.contextMenu(compatibilityRow);
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit GPS…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(callbacks.onDiscardDraft).toHaveBeenCalledTimes(1);
    expect(callbacks.onDiscardDraft).toHaveBeenCalledWith(schemaId);

    const heading = compatibilityRow.closest("section")!.querySelector("h3")!;
    fireEvent.contextMenu(heading);
    expect(
      await screen.findByRole("button", {
        name: /Discard 1 .* edit…/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Remove .*writable/)).toBeDisabled();

    await userEvent.type(
      screen.getByTestId("details-search-input"),
      "has:edits",
    );
    expect(screen.getByText("2 occurrences").closest("tr")).toHaveAttribute(
      "data-occurrence-resolution",
      "multiple",
    );
    expect(screen.getAllByTestId("details-row")).toHaveLength(1);
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
  });

  it("does not create a row for an absent Delete draft with a missing resolution", () => {
    renderPane({
      metadata: {},
      occurrences: [],
      typedDraftEdits: draftCollection({ intent: "Delete", value: null }),
    });

    expect(screen.queryByText("XResolution")).toBeNull();
    expect(
      document.querySelector('[data-occurrence-resolution="multiple"]'),
    ).toBeNull();
    expect(screen.getByTestId("details-section-empty")).toBeInTheDocument();
  });

  it("excludes ambiguous schemas from group Remove but retains group Discard", async () => {
    renderPane({
      metadata: metadataCollection([
        { id: schemaId, value: { kind: "Integer", value: 300 } },
      ]),
      typedDraftEdits: draftCollection({
        intent: "Set",
        value: { kind: "Integer", value: 301 },
      }),
    });
    const aggregate = screen.getByText("2 occurrences").closest("tr")!;
    fireEvent.contextMenu(aggregate.closest("section")!.querySelector("h3")!);

    expect(
      await screen.findByRole("button", {
        name: "Discard 1 Exif::Main edit…",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Remove .*writable/)).toBeDisabled();
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

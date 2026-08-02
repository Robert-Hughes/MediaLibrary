import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { GPS_IDS } from "../metadata/knownIds";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataOccurrence,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetToken,
} from "../utils/metadataDraftTarget";
import { metadataOccurrenceIdToken } from "../utils/metadataOccurrenceId";
import { makeFile } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";
import {
  _resetWritableSchemaDefinitionsCache,
  _setWritableSchemaDefinitionsCache,
} from "../hooks/useWritableSchemaDefinitions";

const file = makeFile({ relative_path: "exact-row.jpg" });
const schemaId: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "282",
};
const otherSchemaId: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "283",
};
const tagInfo: TagInfo = {
  id: schemaId,
  group: "IFD0",
  name: "XResolution",
  writable: true,
  kind: { kind: "Integer", data: { min: null, max: null } },
  description: null,
};

function occurrence(
  path: string,
  value: number,
  options: {
    copy?: number;
    info?: TagInfo;
    group1?: string;
  } = {},
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path,
      runtime_tag_id: "282",
      tag_id_scope: { table: "Exif::Main", tag_id: "282", index: null },
      copy: options.copy ?? 0,
    },
    schema_id: (options.info ?? tagInfo).id,
    value: { kind: "Integer", value },
    tag_info: options.info ?? tagInfo,
    observed_selector: {
      group1: options.group1 ?? "IFD0",
      group7: "ID-Test",
      tag_name: "XResolution",
    },
    write_target: {
      group1: options.group1 ?? "IFD0",
      group7: "ID-Test",
      tag_name: "XResolution",
    },
  };
}

const occurrenceA = occurrence("JPEG-APP1-IFD0", 300);
const occurrenceB = occurrence("JPEG-APP1-IFD1", 72, {
  copy: 1,
  group1: "IFD1",
});

function stagedNewProperty() {
  const schema: SchemaDefinitionId = {
    table: "XMP::dc",
    tag_id: "title",
  };
  const info: TagInfo = {
    id: schema,
    group: "XMP-dc",
    name: "Title",
    writable: true,
    kind: { kind: "Text" },
    description: null,
  };
  _setTagInfoCacheEntry(schema, info);
  _setWritableSchemaDefinitionsCache([info]);
  const target = {
    kind: "NewProperty" as const,
    schema_id: schema,
    write_target: {
      group1: "XMP-custom",
      group7: "ID-title",
      tag_name: "Title",
    },
  };
  const edit: MetadataDraftEdit = {
    intent: "Set",
    value: { kind: "Text", value: "draft title" },
  };
  const store = new TargetDraftEditsStore();
  store.setMetadataTarget(file.relative_path, target, edit);
  return { schema, info, target, edit, store };
}

function stagedGpsNewProperty(group1 = "CustomGPS") {
  const info: TagInfo = {
    id: GPS_IDS.latitude,
    group: "GPS",
    name: "GPSLatitude",
    writable: true,
    kind: { kind: "Real" },
    description: null,
  };
  _setTagInfoCacheEntry(GPS_IDS.latitude, info);
  _setWritableSchemaDefinitionsCache([info]);
  const target = {
    kind: "NewProperty" as const,
    schema_id: GPS_IDS.latitude,
    write_target: {
      group1,
      group7: "ID-2",
      tag_name: "GPSLatitude",
    },
  };
  const edit: MetadataDraftEdit = {
    intent: "Set",
    value: { kind: "Real", value: 51.5 },
  };
  const store = new TargetDraftEditsStore();
  store.setMetadataTarget(file.relative_path, target, edit);
  return { info, target, edit, store };
}

function registerGpsTagInfos() {
  const fields: Array<{
    id: (typeof GPS_IDS)[keyof typeof GPS_IDS];
    name: string;
    kind: TagKind;
  }> = [
    { id: GPS_IDS.latitude, name: "GPSLatitude", kind: { kind: "Real" } },
    {
      id: GPS_IDS.latitudeRef,
      name: "GPSLatitudeRef",
      kind: { kind: "Text" },
    },
    { id: GPS_IDS.longitude, name: "GPSLongitude", kind: { kind: "Real" } },
    {
      id: GPS_IDS.longitudeRef,
      name: "GPSLongitudeRef",
      kind: { kind: "Text" },
    },
    { id: GPS_IDS.altitude, name: "GPSAltitude", kind: { kind: "Real" } },
    {
      id: GPS_IDS.altitudeRef,
      name: "GPSAltitudeRef",
      kind: { kind: "Integer", data: { min: null, max: null } },
    },
  ];
  for (const field of fields) {
    _setTagInfoCacheEntry(field.id, {
      id: field.id,
      group: "GPS",
      name: field.name,
      writable: true,
      kind: field.kind,
      description: null,
    });
  }
}

function gpsExistingOccurrence(): MetadataOccurrence {
  const info: TagInfo = {
    id: GPS_IDS.latitude,
    group: "GPS",
    name: "GPSLatitude",
    writable: true,
    kind: { kind: "Real" },
    description: null,
  };
  _setTagInfoCacheEntry(GPS_IDS.latitude, info);
  return {
    id: {
      document: null,
      path: "JPEG-APP1-GPS",
      runtime_tag_id: "2",
      tag_id_scope: {
        table: GPS_IDS.latitude.table,
        tag_id: GPS_IDS.latitude.tag_id,
        index: GPS_IDS.latitude.index ?? null,
      },
      copy: 0,
    },
    schema_id: structuredClone(GPS_IDS.latitude),
    value: { kind: "Real", value: 51.5 },
    tag_info: info,
    observed_selector: {
      group1: "GPS",
      group7: "ID-2",
      tag_name: "GPSLatitude",
    },
    write_target: {
      group1: "GPS",
      group7: "ID-2",
      tag_name: "GPSLatitude",
    },
  };
}

function targetDrafts(source: MetadataOccurrence, edit: MetadataDraftEdit) {
  const target = exactTarget(source);
  const store = new TargetDraftEditsStore();
  store.setMetadataTarget(file.relative_path, target, edit);
  return {
    target,
    drafts: store.getMetadataFile(file.relative_path),
  };
}

function exactTarget(source: MetadataOccurrence) {
  const resolution = existingOccurrenceTargetFromOccurrence(source);
  if (resolution.kind !== "targetable") throw new Error(resolution.reason);
  return resolution.target;
}

function renderPane(options: {
  occurrences?: Parameters<typeof DetailsPane>[0]["occurrences"];
  targetDraftEdits?: Parameters<typeof DetailsPane>[0]["targetDraftEdits"];
  targetDraftPersistence?: Parameters<
    typeof DetailsPane
  >[0]["targetDraftPersistence"];
  onPreviewGpsTargetDraftBatch?: Parameters<
    typeof DetailsPane
  >[0]["onPreviewGpsTargetDraftBatch"];
}) {
  const callbacks = {
    onSetExistingOccurrenceDraft: vi.fn(),
    onRemoveMetadataTargets: vi.fn(),
    onApplyGpsTargetDraftBatch: vi.fn(() => true),
    onSetNewPropertyDraft: vi.fn(async () => true),
    onReplaceNewPropertyDraftTarget: vi.fn(async () => true),
    onDiscardTargetPropertyDraft: vi.fn(),
    onDiscardTargetDraftBatch: vi.fn(),
  };
  const pane = (next: typeof options) => (
    <DetailsPane
      file={file}

      occurrences={next.occurrences ?? [occurrenceA]}
      targetDraftEdits={next.targetDraftEdits}
      targetDraftPersistence={next.targetDraftPersistence}
      {...callbacks}
      onPreviewGpsTargetDraftBatch={next.onPreviewGpsTargetDraftBatch}
    />
  );
  const rendered = render(pane(options));
  return {
    ...callbacks,
    rerenderPane(next: typeof options) {
      rendered.rerender(pane(next));
    },
  };
}

async function openExistingOccurrenceEditor() {
  const row = screen
    .getByText("XResolution")
    .closest('[data-testid="details-row"]')!;
  const user = userEvent.setup();
  await user.pointer({ target: row, keys: "[MouseRight]" });
  await user.click(screen.getByRole("button", { name: "Edit…" }));
  return row;
}
function existingOccurrenceRows() {
  return screen
    .queryAllByTestId("details-row")
    .filter((row) => row.dataset.rowKind === "ExistingOccurrenceRow");
}

function newPropertyRows() {
  return screen
    .queryAllByTestId("details-row")
    .filter((row) => row.dataset.rowKind === "NewPropertyRow");
}

function missingOccurrenceDraftRows() {
  return screen
    .queryAllByTestId("details-row")
    .filter((row) => row.dataset.rowKind === "MissingOccurrenceDraftRow");
}

function rowForNewPropertyTarget(
  target:
    | ReturnType<typeof stagedNewProperty>["target"]
    | ReturnType<typeof stagedGpsNewProperty>["target"],
) {
  const token = metadataDraftTargetToken(target);
  const row = newPropertyRows().find(
    (candidate) => candidate.dataset.targetToken === token,
  );
  if (!row) throw new Error(`New Property row not found for ${token}`);
  return row;
}

function rowForOccurrence(source: MetadataOccurrence) {
  const token = metadataOccurrenceIdToken(source.id);
  const row = existingOccurrenceRows().find(
    (candidate) => candidate.dataset.occurrenceToken === token,
  );
  if (!row) throw new Error(`Occurrence row not found for ${token}`);
  return row;
}

function tooltipCells(row: HTMLElement) {
  const name = row.querySelector<HTMLElement>(".details-key");
  const value = row.querySelector<HTMLElement>(".details-value");
  if (!name || !value) throw new Error("Details tooltip cells not found");
  return { name, value };
}

beforeEach(() => {
  _clearTagInfoCache();
  _setTagInfoCacheEntry(schemaId, tagInfo);
  _resetWritableSchemaDefinitionsCache();
});

describe("DetailsPane exact target-owned row presentation", () => {
  it("renders separate curated name and value tooltips for an occurrence", () => {
    renderPane({ occurrences: [occurrenceA] });
    const row = rowForOccurrence(occurrenceA);
    const { name, value } = tooltipCells(row);

    expect(row).not.toHaveAttribute("title");
    expect(name.title).not.toBe(value.title);
    expect(name.title).toContain("Property: XResolution");
    expect(name.title).toContain("Family 1: IFD0");
    expect(name.title).toContain("Family 3: Main");
    expect(name.title).toContain("Family 4: Copy0");
    expect(name.title).toContain("Family 5: JPEG-APP1-IFD0");
    expect(name.title).toContain("Family 7: ID-Test");
    expect(name.title).toContain("Schema table: Exif::Main");
    expect(name.title).toContain("Schema tag ID: 282");
    expect(name.title).toContain("Schema datatype: Integer (I)");
    expect(name.title).toContain("Schema writable: true");
    expect(name.title).toContain("Editable: true");
    expect(value.title).toContain("Current value: 300");
    expect(value.title).toContain("Current datatype: Integer (I)");
    expect(value.title).toContain("Current matches schema: true");
    expect(value.title).toContain("Draft action: none");
    expect(name.title).not.toMatch(/^\s*[{[]/m);
    expect(value.title).not.toContain(row.dataset.occurrenceToken ?? "[]");
    expect(
      row.querySelector('[data-testid^="datatype-badge-"]'),
    ).not.toHaveAttribute("title");
  });

  it("uses destination semantics for New Property tooltips", () => {
    const { target, store } = stagedNewProperty();
    renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    const { name, value } = tooltipCells(rowForNewPropertyTarget(target));

    expect(name.title).toContain("Field state: New property");
    expect(name.title).toContain("Destination family 1: XMP-custom");
    expect(name.title).toContain("Destination family 7: ID-title");
    expect(name.title).not.toContain("Family 3:");
    expect(name.title).toContain("Schema datatype: String (S)");
    expect(value.title).toContain("Current value: not present");
    expect(value.title).toContain("Draft action: Set");
    expect(value.title).toContain("Staged value: draft title");
    expect(value.title).toContain("Staged datatype: String (S)");
  });

  it("labels missing-occurrence identity and value tooltip state", () => {
    const { drafts } = targetDrafts(occurrenceA, {
      intent: "Delete",
      value: null,
    });
    renderPane({ occurrences: [], targetDraftEdits: drafts });
    const row = missingOccurrenceDraftRows()[0];
    const { name, value } = tooltipCells(row);

    expect(name.title).toContain("Field state: Missing occurrence");
    expect(name.title).toContain("Family 5: JPEG-APP1-IFD0");
    expect(name.title).toContain("Editable: false");
    expect(name.title).toContain("Status: Missing occurrence");
    expect(value.title).toContain("Current value: occurrence missing");
    expect(value.title).toContain("Draft action: Delete");
    expect(value.title).toContain("Staged value: deleted");
  });

  it("keeps a pending-conflicted New Property exactly discardable and destination-editable", () => {
    const staged = stagedNewProperty();
    const conflictingTarget = {
      ...exactTarget(occurrenceA),
      write_target: {
        ...staged.target.write_target,
        group1: staged.target.write_target.group1.toUpperCase(),
        tag_name: staged.target.write_target.tag_name.toLowerCase(),
      },
    };
    staged.store.setMetadataTarget(file.relative_path, conflictingTarget, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: staged.store.getMetadataFile(file.relative_path),
    });

    const row = rowForNewPropertyTarget(staged.target);
    expect(row).toHaveTextContent("Destination used by pending edit");
    expect(tooltipCells(row).name).toHaveAttribute(
      "title",
      expect.stringContaining("Status: Destination used by pending edit"),
    );
    expect(tooltipCells(row).name.title).not.toContain(
      JSON.stringify(conflictingTarget),
    );
    fireEvent.contextMenu(row);
    expect(
      screen.getByRole("button", { name: "Edit destination…" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(
      staged.target,
    );
    expect(view.onDiscardTargetPropertyDraft).not.toHaveBeenCalledWith(
      conflictingTarget,
    );
  });

  it("keeps a same-schema Set draft on its exact occurrence row", () => {
    const { drafts } = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: drafts,
    });

    expect(existingOccurrenceRows()).toHaveLength(2);
    const targetRow = rowForOccurrence(occurrenceA);
    const siblingRow = rowForOccurrence(occurrenceB);
    expect(targetRow.querySelector(".draft-original")).toHaveTextContent("300");
    expect(targetRow.querySelector(".draft-new")).toHaveTextContent("301");
    expect(targetRow).toHaveAttribute("data-has-exact-draft", "true");
    expect(targetRow).not.toHaveAttribute("data-readonly");
    expect(siblingRow).toHaveTextContent("72");
    expect(siblingRow).not.toHaveAttribute("data-readonly");
    expect(missingOccurrenceDraftRows()).toHaveLength(0);

    fireEvent.contextMenu(targetRow);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard edit" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("edits and removes occurrence A only through its exact callbacks", () => {
    const view = renderPane({
      occurrences: [occurrenceA, occurrenceB],
    });
    const rowA = rowForOccurrence(occurrenceA);
    fireEvent.contextMenu(rowA);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(300);
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "305" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      exactTarget(occurrenceA),
      expect.objectContaining({
        intent: "Set",
        value: { kind: "Integer", value: 305 },
      }),
    );
    expect(view.onRemoveMetadataTargets).not.toHaveBeenCalled();

    fireEvent.contextMenu(rowA);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(view.onRemoveMetadataTargets).toHaveBeenCalledWith([
      exactTarget(occurrenceA),
    ]);
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledTimes(1);
  });

  it("shows exact Delete on A, filters has:edits exactly, and discards A", async () => {
    const { target, drafts } = targetDrafts(occurrenceA, {
      intent: "Delete",
      value: null,
    });
    const view = renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: drafts,
    });
    const rowA = rowForOccurrence(occurrenceA);
    expect(rowA.querySelector(".draft-original")).toHaveTextContent("300");
    expect(rowA.querySelector(".draft-new")).toHaveTextContent("—");
    expect(missingOccurrenceDraftRows()).toHaveLength(0);

    const user = userEvent.setup();
    await user.type(screen.getByTestId("details-search-input"), "has:edits");
    const filtered = existingOccurrenceRows();
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toHaveAttribute(
      "data-occurrence-token",
      metadataOccurrenceIdToken(occurrenceA.id),
    );
    await user.pointer({ target: filtered[0], keys: "[MouseRight]" });
    await user.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it("keeps an unsupported staged preview neutral, exact-discardable, and blocked from editing", () => {
    const reason = "A list payload cannot be rendered for a non-list schema.";
    const { target, drafts } = targetDrafts(occurrenceA, {
      intent: "ListAdd",
      value: {
        kind: "List",
        value: {
          list_kind: "Bag",
          items: [{ kind: "Integer", value: 301 }],
        },
      },
    });
    const view = renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: drafts,
    });
    const row = rowForOccurrence(occurrenceA);

    expect(row).toHaveTextContent("300");
    expect(row).toHaveTextContent("Preview unavailable");
    expect(row).not.toHaveTextContent("—");
    expect(row.querySelector(".draft-original")).toBeNull();
    expect(row).toHaveAttribute("data-has-pending-operation", "true");
    expect(row).not.toHaveAttribute("title");
    const { name, value } = tooltipCells(row);
    expect(name.title).toContain("Editable: false");
    expect(name.title).not.toContain(reason);
    expect(value).toHaveAttribute(
      "title",
      expect.stringContaining(`Reason: ${reason}`),
    );
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.queryByTestId("typed-value-editor")).toBeNull();
    expect(screen.getByTestId("details-editor-unavailable")).toHaveTextContent(
      /cannot be previewed safely.*discarded or replaced/i,
    );

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it.each([
    ["ListAdd", "existing, kept, staged"],
    ["ListRemove", "kept"],
  ] as const)(
    "shows the effective exact-occurrence %s value without changing intent",
    (intent, expected) => {
      const listInfo: TagInfo = {
        ...tagInfo,
        kind: { kind: "Bag", data: { kind: "Text" } },
      };
      const listA: MetadataOccurrence = {
        ...occurrenceA,
        tag_info: listInfo,
        value: {
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [
              { kind: "Text", value: "existing" },
              { kind: "Text", value: "kept" },
            ],
          },
        },
      };
      const listB: MetadataOccurrence = {
        ...occurrenceB,
        tag_info: listInfo,
        value: {
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [{ kind: "Text", value: "sibling" }],
          },
        },
      };
      const { drafts } = targetDrafts(listA, {
        intent,
        value: {
          kind: "Text",
          value: intent === "ListAdd" ? "staged" : "existing",
        },
      });
      renderPane({
        occurrences: [listA, listB],
        targetDraftEdits: drafts,
      });
      const rowA = rowForOccurrence(listA);
      expect(rowA.querySelector(".draft-new")).toHaveTextContent(expected);
    },
  );

  it("keeps a stale complete target visible without overlay or redirection", () => {
    const current = existingOccurrenceTargetFromOccurrence(occurrenceA);
    if (current.kind !== "targetable") throw new Error(current.reason);
    const staleStore = new TargetDraftEditsStore();
    staleStore.setMetadataTarget(
      file.relative_path,
      {
        ...current.target,
        write_target: { ...current.target.write_target, group1: "IFD1" },
      },
      { intent: "Set", value: { kind: "Integer", value: 301 } },
    );
    renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: staleStore.getMetadataFile(file.relative_path),
    });
    const staleRows = existingOccurrenceRows();
    expect(staleRows).toHaveLength(2);
    for (const row of staleRows) {
      expect(row).not.toHaveAttribute("data-has-exact-draft");
      expect(row.querySelector(".draft-new")).toBeNull();
    }
    expect(rowForOccurrence(occurrenceA)).toHaveAttribute(
      "data-readonly",
      "true",
    );
    expect(rowForOccurrence(occurrenceA)).toHaveTextContent("Stale target");
    expect(rowForOccurrence(occurrenceB)).not.toHaveAttribute("data-readonly");
    expect(missingOccurrenceDraftRows()).toHaveLength(0);
  });

  it("keeps a same-schema sibling eligible before and after A is discarded", () => {
    const pending = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    const view = renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: pending.drafts,
    });
    const siblingToken = metadataOccurrenceIdToken(occurrenceB.id);
    expect(
      existingOccurrenceRows().find(
        (row) => row.dataset.occurrenceToken === siblingToken,
      ),
    ).not.toHaveAttribute("data-readonly");

    view.rerenderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: undefined,
    });
    const sibling = existingOccurrenceRows().find(
      (row) => row.dataset.occurrenceToken === siblingToken,
    )!;
    expect(sibling).not.toHaveAttribute("data-readonly");
    fireEvent.contextMenu(sibling);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
  });

  it("keeps a schema-projection-omitted Delete visible with exact original, staged deletion, and individual discard", () => {
    const { target, drafts } = targetDrafts(occurrenceA, {
      intent: "Delete",
      value: null,
    });
    const view = renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: drafts,
    });

    const [row] = existingOccurrenceRows();
    expect(row.querySelector(".draft-original")).toHaveTextContent("300");
    expect(row.querySelector(".draft-new")).toHaveTextContent("—");
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
    expect(screen.queryByTestId("details-target-drafts-ambiguous")).toBeNull();

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it.each(["ListAdd", "ListRemove"] as const)(
    "keeps a schema-projection-omitted %s target row visible",
    (intent) => {
      const listInfo: TagInfo = {
        ...tagInfo,
        kind: { kind: "Bag", data: { kind: "Text" } },
      };
      const listOccurrence: MetadataOccurrence = {
        ...occurrenceA,
        value: {
          kind: "List",
          value: {
            list_kind: "Bag",
            items: [{ kind: "Text", value: "existing" }],
          },
        },
        tag_info: listInfo,
      };
      _setTagInfoCacheEntry(schemaId, listInfo);
      const { drafts } = targetDrafts(listOccurrence, {
        intent,
        value: { kind: "Text", value: "staged" },
      });
      renderPane({
        occurrences: [listOccurrence],
        targetDraftEdits: drafts,
      });
      expect(existingOccurrenceRows()).toHaveLength(1);
    },
  );

  it("does not duplicate a target-owned row already present in schema projection", () => {
    const { drafts } = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: drafts,
    });
    expect(existingOccurrenceRows()).toHaveLength(1);
  });

  it("makes targetable schema-projection-omitted occurrences exact-edit candidates", () => {
    renderPane({ occurrences: [occurrenceA, occurrenceB] });
    const rows = existingOccurrenceRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).not.toHaveAttribute("data-readonly");
      fireEvent.contextMenu(row);
      expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Remove" }),
      ).toBeInTheDocument();
      fireEvent.keyDown(document, { key: "Escape" });
    }
  });

  it.each([
    ["unknown schema", { ...occurrenceA, tag_info: null }, /no exact TagInfo/i],
    [
      "read-only schema",
      { ...occurrenceA, tag_info: { ...tagInfo, writable: false } },
      /read-only/i,
    ],
    [
      "missing write target",
      { ...occurrenceA, write_target: null },
      /not backed by the identical observed selector/i,
    ],
  ])("keeps a derived row read-only for %s", (_label, item, reason) => {
    renderPane({ occurrences: [item] });
    const row = existingOccurrenceRows()[0];
    expect(row).toHaveAttribute("data-readonly", "true");
    expect(row).not.toHaveAttribute("title");
    expect(tooltipCells(row).name).toHaveAttribute(
      "title",
      expect.stringMatching(reason),
    );
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables occurrence actions after a target-aware persistence load failure", () => {
    renderPane({
      occurrences: [occurrenceA],
      targetDraftPersistence: {
        status: "load-failed",
        error: "bad target-aware",
      },
    });
    const row = existingOccurrenceRows()[0];
    expect(row).toHaveAttribute("data-readonly", "true");
    expect(row).not.toHaveAttribute("title");
    expect(tooltipCells(row).name).toHaveAttribute(
      "title",
      expect.stringContaining(
        "Reason: Target-aware draft persistence did not load safely.",
      ),
    );
  });

  it("keeps NewProperty and exact occurrence actions separate", () => {
    renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: (() => {
        const store = new TargetDraftEditsStore();
        store.setMetadataTarget(
          file.relative_path,
          {
            kind: "NewProperty",
            schema_id: schemaId,
            write_target: {
              group1: "XMP-test",
              group7: "ID-Test",
              tag_name: "TestTag",
            },
          },
          { intent: "Set", value: { kind: "Integer", value: 301 } },
        );
        return store.getMetadataFile(file.relative_path);
      })(),
    });
    const row = existingOccurrenceRows()[0];
    expect(row).not.toHaveAttribute("data-readonly", "true");
  });

  it("keeps duplicate IDs read-only while a distinct GPS occurrence stays visible", () => {
    const duplicateView = renderPane({
      occurrences: [occurrenceA, structuredClone(occurrenceA)],
    });
    for (const row of existingOccurrenceRows()) {
      expect(row).toHaveAttribute("data-readonly", "true");
      expect(row).not.toHaveAttribute("title");
      expect(tooltipCells(row).name).toHaveAttribute(
        "title",
        expect.stringContaining("Status: Duplicate occurrence ID"),
      );
    }

    const gpsInfo: TagInfo = {
      id: GPS_IDS.latitude,
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    };
    duplicateView.rerenderPane({
      occurrences: [
        {
          id: {
            document: null,
            path: "JPEG-APP1-GPS",
            runtime_tag_id: "2",
            tag_id_scope: {
              table: "TestFixture::Runtime",
              tag_id: "2",
              index: null,
            },
            copy: 0,
          },
          schema_id: gpsInfo.id,
          value: { kind: "Real", value: 51.5 },
          tag_info: gpsInfo,
          observed_selector: {
            group1: "GPS",
            group7: "ID-Test",
            tag_name: "GPSLatitude",
          },
          write_target: {
            group1: "GPS",
            group7: "ID-Test",
            tag_name: "GPSLatitude",
          },
        },
      ],
    });
    const [gpsRow] = existingOccurrenceRows();
    expect(gpsRow).toBeInTheDocument();
  });
});

describe("DetailsPane exact occurrence and New Property editor identity", () => {
  it("captures occurrence A, saves A, and refreshes A's changed value explicitly", async () => {
    const view = renderPane({
      occurrences: [occurrenceA],
    });
    await openExistingOccurrenceEditor();
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(300);

    const changedA: MetadataOccurrence = {
      ...occurrenceA,
      value: { kind: "Integer", value: 302 },
    };
    await act(async () => {
      view.rerenderPane({
        occurrences: [changedA],
      });
    });
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(302);
    const user = userEvent.setup();
    await user.clear(screen.getByTestId("numeric-editor-input"));
    await user.type(screen.getByTestId("numeric-editor-input"), "303");
    await user.click(screen.getByTestId("numeric-editor-save"));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      exactTarget(occurrenceA),
      expect.objectContaining({
        intent: "Set",
        value: { kind: "Integer", value: 303 },
      }),
    );
  });
  it.each([
    ["loading", "loading" as const],
    ["missing", []],
    ["duplicate exact ID", [occurrenceA, structuredClone(occurrenceA)]],
    ["same-schema replacement B", [occurrenceB]],
    [
      "changed selector",
      [
        {
          ...occurrenceA,
          write_target: { ...occurrenceA.write_target!, group1: "IFD1" },
        },
      ],
    ],
    [
      "changed embedded schema",
      [
        {
          ...occurrenceA,
          tag_info: { ...tagInfo, id: otherSchemaId },
        },
      ],
    ],
  ])("blocks saving when A becomes %s", async (_label, nextOccurrences) => {
    const pending = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    const originalDrafts = structuredClone(pending.drafts);
    const view = renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: pending.drafts,
    });
    await openExistingOccurrenceEditor();
    expect(screen.getByTestId("numeric-editor-save")).toBeInTheDocument();
    await act(async () => {
      view.rerenderPane({
        occurrences: nextOccurrences,
        targetDraftEdits: pending.drafts,
      });
    });

    await waitFor(() =>
      expect(screen.queryByTestId("numeric-editor-overlay")).toBeNull(),
    );
    expect(screen.getByTestId("details-editor-unavailable")).toHaveTextContent(
      /nothing was saved|without saving/i,
    );
    expect(view.onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(view.onRemoveMetadataTargets).not.toHaveBeenCalled();
    expect(pending.drafts).toEqual(originalDrafts);
  });

  it("keeps a staged Set as the seed and a staged Delete seeded from exact current value", async () => {
    for (const [edit, expected] of [
      [{ intent: "Set", value: { kind: "Integer", value: 301 } }, 301],
      [{ intent: "Delete", value: null }, 300],
    ] as const) {
      const { drafts } = targetDrafts(occurrenceA, edit);
      const rendered = render(
        <DetailsPane
          file={file}

          occurrences={[occurrenceA]}
          targetDraftEdits={drafts}
          onRemoveMetadataTargets={vi.fn()}
          onDiscardTargetDraftBatch={vi.fn()}
        />,
      );
      await openExistingOccurrenceEditor();
      expect(screen.getByTestId("numeric-editor-input")).toHaveValue(expected);
      rendered.unmount();
    }
  });

  it.each([
    ["ListAdd", "pending"],
    ["ListRemove", ""],
  ] as const)(
    "reopens a scalar %s from its backend-effective value",
    (intent, expected) => {
      const textInfo: TagInfo = {
        ...tagInfo,
        kind: { kind: "Text" },
      };
      const textOccurrence: MetadataOccurrence = {
        ...occurrenceA,
        value: { kind: "Text", value: "disk" },
        tag_info: textInfo,
      };
      _setTagInfoCacheEntry(schemaId, textInfo);
      const { drafts } = targetDrafts(textOccurrence, {
        intent,
        value: { kind: "Text", value: "pending" },
      });
      renderPane({
        occurrences: [textOccurrence],
        targetDraftEdits: drafts,
      });

      const row = rowForOccurrence(textOccurrence);
      expect(row.querySelector(".draft-new")).toHaveTextContent(
        intent === "ListAdd" ? "pending" : "—",
      );
      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
      expect(screen.getByTestId("value-edit-input")).toHaveValue(expected);
    },
  );

  it("routes an individual GPS edit through its exact occurrence callback", async () => {
    const gpsInfo: TagInfo = {
      id: GPS_IDS.latitude,
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    };
    _setTagInfoCacheEntry(GPS_IDS.latitude, gpsInfo);
    const gpsOccurrence: MetadataOccurrence = {
      id: {
        document: null,
        path: "JPEG-APP1-GPS",
        runtime_tag_id: "2",
        tag_id_scope: {
          table: "TestFixture::Runtime",
          tag_id: "2",
          index: null,
        },
        copy: 0,
      },
      schema_id: gpsInfo.id,
      value: { kind: "Real", value: 51.5 },
      tag_info: gpsInfo,
      observed_selector: {
        group1: "GPS",
        group7: "ID-Test",
        tag_name: "GPSLatitude",
      },
      write_target: {
        group1: "GPS",
        group7: "ID-Test",
        tag_name: "GPSLatitude",
      },
    };
    const view = renderPane({
      occurrences: [gpsOccurrence],
    });
    const row = screen.getByText("GPSLatitude").closest("tr")!;
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "52" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      exactTarget(gpsOccurrence),
      { intent: "Set", value: { kind: "Real", value: 52 } },
    );
    expect(view.onRemoveMetadataTargets).not.toHaveBeenCalled();
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
  });

  it("moves a New Property destination without reopening the value editor", async () => {
    const newId: SchemaDefinitionId = {
      table: "XMP::dc",
      tag_id: "title",
    };
    const newInfo: TagInfo = {
      id: newId,
      group: "XMP-dc",
      name: "Title",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    };
    _setTagInfoCacheEntry(newId, newInfo);
    _setWritableSchemaDefinitionsCache([newInfo]);
    const store = new TargetDraftEditsStore();
    const newTarget = {
      kind: "NewProperty" as const,
      schema_id: newId,
      write_target: {
        group1: "XMP-custom",
        group7: "ID-title",
        tag_name: "Title",
      },
    };
    store.setMetadataTarget(file.relative_path, newTarget, {
      intent: "Set",
      value: { kind: "Text", value: "draft title" },
    });
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    const row = screen.getByText("draft title").closest("tr")!;
    fireEvent.contextMenu(row);
    expect(
      screen.getByRole("button", { name: "Edit value…" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit destination…" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("new-property-destination-group")).toHaveValue(
        "XMP-custom",
      );
    });
    const destination = screen.getByTestId("new-property-destination-group");
    await userEvent.clear(destination);
    await userEvent.type(destination, "XMP-moved");
    await userEvent.click(screen.getByTestId("new-property-next"));
    await waitFor(() =>
      expect(view.onReplaceNewPropertyDraftTarget).toHaveBeenCalledWith(
        newTarget,
        {
          ...newTarget,
          write_target: { ...newTarget.write_target, group1: "XMP-moved" },
        },
        {
          intent: "Set",
          value: { kind: "Text", value: "draft title" },
        },
      ),
    );
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(view.onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
  });

  it("offers separate New Property row actions and edits only the exact New Property value", async () => {
    const { target, store } = stagedNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    const row = screen.getByText("draft title").closest("tr")!;
    fireEvent.contextMenu(row);
    expect(
      screen.getByRole("button", { name: "Edit value…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit destination…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard edit" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    expect(screen.queryByTestId("new-property-destination-group")).toBeNull();
    const input = screen.getByTestId("value-edit-input");
    expect(input).toHaveValue("draft title");
    await userEvent.clear(input);
    await userEvent.type(input, "updated title");
    await userEvent.click(screen.getByTestId("value-edit-save"));

    await waitFor(() =>
      expect(view.onSetNewPropertyDraft).toHaveBeenCalledWith(target, {
        intent: "Set",
        value: { kind: "Text", value: "updated title" },
      }),
    );
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
  });

  it("edits a GPS New Property row through its exact custom destination", async () => {
    const { target, store } = stagedGpsNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    const row = screen.getByText("GPSLatitude").closest("tr")!;
    fireEvent.contextMenu(row);
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(51.5);
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "52.25" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    await waitFor(() =>
      expect(view.onSetNewPropertyDraft).toHaveBeenCalledWith(target, {
        intent: "Set",
        value: { kind: "Real", value: 52.25 },
      }),
    );
    expect(target.write_target.group1).toBe("CustomGPS");
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("numeric-editor-input")).toBeNull(),
    );
  });

  it("opens the grouped GPS editor from an exact GPS New Property row", async () => {
    const { target, store } = stagedGpsNewProperty();
    registerGpsTagInfos();
    renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });

    fireEvent.contextMenu(rowForNewPropertyTarget(target));
    const editGps = screen.getByRole("button", { name: "Edit GPS…" });
    expect(editGps).toBeEnabled();
    await userEvent.click(editGps);

    expect(await screen.findByTestId("gps-editor-overlay")).toBeInTheDocument();
  });

  it("defers stale grouped GPS validation to the Rust preview", async () => {
    const occurrence = gpsExistingOccurrence();
    const staleTarget = exactTarget(occurrence);
    staleTarget.write_target.group1 = "StaleGPS";
    const store = new TargetDraftEditsStore();
    store.setMetadataTarget(file.relative_path, staleTarget, {
      intent: "Set",
      value: { kind: "Real", value: 52 },
    });
    const preview = vi.fn(async () => null);
    renderPane({
      occurrences: [occurrence],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
      onPreviewGpsTargetDraftBatch: preview,
    });

    fireEvent.contextMenu(rowForOccurrence(occurrence));
    const editGps = screen.getByRole("button", { name: "Edit GPS…" });
    expect(editGps).toBeEnabled();
    fireEvent.click(editGps);
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
  });

  it("defers duplicate-schema GPS validation to the Rust preview", async () => {
    const occurrence = gpsExistingOccurrence();
    const preview = vi.fn(async () => null);
    renderPane({
      occurrences: [occurrence, structuredClone(occurrence)],
      onPreviewGpsTargetDraftBatch: preview,
    });

    fireEvent.contextMenu(existingOccurrenceRows()[0]);
    const editGps = screen.getByRole("button", { name: "Edit GPS…" });
    expect(editGps).toBeEnabled();
    fireEvent.click(editGps);
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(screen.queryByTestId("gps-editor-overlay")).toBeNull();
  });

  it("keeps a custom GPS New Property editor open when async staging fails", async () => {
    const { target, store } = stagedGpsNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    view.onSetNewPropertyDraft.mockResolvedValueOnce(false);
    fireEvent.contextMenu(screen.getByText("GPSLatitude").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/remains open/i),
    );
    expect(view.onSetNewPropertyDraft).toHaveBeenCalledWith(target, {
      intent: "Set",
      value: { kind: "Real", value: 51.5 },
    });
    expect(screen.getByTestId("numeric-editor-input")).toBeInTheDocument();
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
  });

  it("keeps the value editor open when async staging fails", async () => {
    const { store } = stagedNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    view.onSetNewPropertyDraft.mockResolvedValueOnce(false);
    fireEvent.contextMenu(screen.getByText("draft title").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    await userEvent.click(screen.getByTestId("value-edit-save"));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/remains open/i),
    );
    expect(screen.getByTestId("value-edit-input")).toBeInTheDocument();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
  });

  it("cancels New Property value editing without changing either target or edit", async () => {
    const { store } = stagedNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    fireEvent.contextMenu(screen.getByText("draft title").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    await userEvent.clear(screen.getByTestId("value-edit-input"));
    await userEvent.type(screen.getByTestId("value-edit-input"), "cancelled");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
  });

  it("blocks a stale exact New Property target without retargeting a sibling", async () => {
    const { schema, target, edit, store } = stagedNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    fireEvent.contextMenu(screen.getByText("draft title").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));

    const sibling = {
      ...structuredClone(target),
      write_target: { ...target.write_target, group1: "XMP-sibling" },
    };
    const replacementStore = new TargetDraftEditsStore();
    replacementStore.setMetadataTarget(file.relative_path, sibling, edit);
    view.rerenderPane({
      occurrences: [],
      targetDraftEdits: replacementStore.getMetadataFile(file.relative_path),
    });
    await userEvent.click(screen.getByTestId("value-edit-save"));

    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed or disappeared/i,
    );
    expect(screen.getByTestId("value-edit-input")).toBeInTheDocument();
    expect(sibling.schema_id).toEqual(schema);
  });

  it("does not redirect a stale GPS New Property to a default-destination sibling", async () => {
    const { target, edit, store } = stagedGpsNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    fireEvent.contextMenu(screen.getByText("GPSLatitude").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));

    const defaultSibling = {
      ...structuredClone(target),
      write_target: { ...target.write_target, group1: "GPS" },
    };
    const replacementStore = new TargetDraftEditsStore();
    replacementStore.setMetadataTarget(
      file.relative_path,
      defaultSibling,
      edit,
    );
    view.rerenderPane({
      occurrences: [],
      targetDraftEdits: replacementStore.getMetadataFile(file.relative_path),
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /changed or disappeared/i,
    );
    expect(screen.getByTestId("numeric-editor-input")).toBeInTheDocument();
  });

  it("edits each additional same-schema New Property row by exact target", async () => {
    const { target, edit, store } = stagedNewProperty();
    const sibling = {
      ...structuredClone(target),
      write_target: { ...target.write_target, group1: "XMP-sibling" },
    };
    store.setMetadataTarget(file.relative_path, sibling, edit);
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    expect(newPropertyRows()).toHaveLength(2);
    fireEvent.contextMenu(rowForNewPropertyTarget(sibling));
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    await userEvent.click(screen.getByTestId("value-edit-save"));
    await waitFor(() =>
      expect(view.onSetNewPropertyDraft).toHaveBeenCalledWith(sibling, edit),
    );
    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalledWith(target, edit);
  });

  it("edits only the selected additional GPS New Property destination", async () => {
    const { target, edit, store } = stagedGpsNewProperty();
    const sibling = {
      ...structuredClone(target),
      write_target: { ...target.write_target, group1: "CustomGPS2" },
    };
    store.setMetadataTarget(file.relative_path, sibling, edit);
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(file.relative_path),
    });
    expect(newPropertyRows()).toHaveLength(2);
    fireEvent.contextMenu(rowForNewPropertyTarget(sibling));
    await userEvent.click(screen.getByRole("button", { name: "Edit value…" }));
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "53" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    await waitFor(() =>
      expect(view.onSetNewPropertyDraft).toHaveBeenCalledWith(sibling, {
        intent: "Set",
        value: { kind: "Real", value: 53 },
      }),
    );
    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalledWith(
      target,
      expect.anything(),
    );
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
  });
});

describe("DetailsPane exact workflow strengthening", () => {
  it("renders a missing stored occurrence as a target-only warning with exact discard only", () => {
    const { target, drafts } = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    const view = renderPane({ occurrences: [], targetDraftEdits: drafts });

    const [row] = missingOccurrenceDraftRows();
    expect(row).toBeDefined();
    expect(row).toHaveTextContent("XResolution");
    expect(row).toHaveTextContent("Missing occurrence");
    expect(row).toHaveTextContent("301");

    fireEvent.contextMenu(row);
    expect(
      screen.getByRole("button", { name: "Discard edit" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Edit destination…" }),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
    expect(view.onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(view.onRemoveMetadataTargets).not.toHaveBeenCalled();
  });

  it("edits one exact GPS occurrence when another occurrence shares its schema", async () => {
    const gpsInfo: TagInfo = {
      id: GPS_IDS.latitude,
      group: "GPS",
      name: "GPSLatitude",
      writable: true,
      kind: { kind: "Real" },
      description: null,
    };
    _setTagInfoCacheEntry(GPS_IDS.latitude, gpsInfo);
    const gpsOccurrence = (
      path: string,
      copy: number,
      value: number,
    ): MetadataOccurrence => ({
      id: {
        document: null,
        path,
        runtime_tag_id: GPS_IDS.latitude.tag_id,
        tag_id_scope: {
          table: GPS_IDS.latitude.table,
          tag_id: GPS_IDS.latitude.tag_id,
          index: GPS_IDS.latitude.index ?? null,
        },
        copy,
      },
      schema_id: structuredClone(GPS_IDS.latitude),
      value: { kind: "Real", value },
      tag_info: gpsInfo,
      observed_selector: {
        group1: "GPS",
        group7: "ID-2",
        tag_name: "GPSLatitude",
      },
      write_target: {
        group1: "GPS",
        group7: "ID-2",
        tag_name: "GPSLatitude",
      },
    });
    const first = gpsOccurrence("JPEG-APP1-IFD0-GPS", 0, 51.5);
    const second = gpsOccurrence("JPEG-APP1-IFD1-GPS", 1, 52.5);
    const view = renderPane({ occurrences: [first, second] });

    const secondRow = rowForOccurrence(second);
    fireEvent.contextMenu(secondRow);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit GPS…" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(52.5);
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "53.25" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    await waitFor(() =>
      expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
        exactTarget(second),
        { intent: "Set", value: { kind: "Real", value: 53.25 } },
      ),
    );
    expect(view.onApplyGpsTargetDraftBatch).not.toHaveBeenCalled();
  });
});

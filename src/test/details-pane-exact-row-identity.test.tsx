import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
} from "../types";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { metadataOccurrenceIdToken } from "../utils/metadataOccurrenceId";
import { makePhoto } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";
import {
  _resetWritableSchemaDefinitionsCache,
  _setWritableSchemaDefinitionsCache,
} from "../hooks/useWritableSchemaDefinitions";

const photo = makePhoto({ relative_path: "exact-row.jpg" });
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
  store.setMetadataTarget(photo.relative_path, target, edit);
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
  store.setMetadataTarget(photo.relative_path, target, edit);
  return { info, target, edit, store };
}

function targetDrafts(source: MetadataOccurrence, edit: MetadataDraftEdit) {
  const target = existingOccurrenceTargetFromOccurrence(source);
  if (target.kind !== "targetable") throw new Error(target.reason);
  const store = new TargetDraftEditsStore();
  store.setMetadataTarget(photo.relative_path, target.target, edit);
  return {
    target: target.target,
    drafts: store.getMetadataFile(photo.relative_path),
  };
}

function renderPane(options: {
  occurrences?: Parameters<typeof DetailsPane>[0]["occurrences"];
  targetDraftEdits?: Parameters<typeof DetailsPane>[0]["targetDraftEdits"];
  targetDraftPersistence?: Parameters<
    typeof DetailsPane
  >[0]["targetDraftPersistence"];
}) {
  const callbacks = {
    onSetExistingOccurrenceDraft: vi.fn(),
    onRemoveMetadataFieldsV5: vi.fn(),
    onSetGpsTargetDraftBatch: vi.fn(() => true),
    onSetNewPropertyDraft: vi.fn(async () => true),
    onReplaceNewPropertyDraftTarget: vi.fn(async () => true),
    onDiscardTargetPropertyDraft: vi.fn(),
    onDiscardTargetDraftBatch: vi.fn(),
  };
  const pane = (next: typeof options) => (
    <DetailsPane
      photo={photo}

      occurrences={next.occurrences ?? [occurrenceA]}
      targetDraftEdits={next.targetDraftEdits}
      targetDraftPersistence={next.targetDraftPersistence}
      {...callbacks}
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

function openOrdinaryEditor() {
  const row = screen
    .getByText("XResolution")
    .closest('[data-testid="details-row"]')!;
  fireEvent.contextMenu(row);
  fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
  return row;
}

function ordinaryMetadataRows() {
  return screen
    .queryAllByTestId("details-row")
    .filter((row) => row.hasAttribute("data-row-key"));
}

beforeEach(() => {
  _clearTagInfoCache();
  _setTagInfoCacheEntry(schemaId, tagInfo);
  _resetWritableSchemaDefinitionsCache();
});

describe("DetailsPane exact target-owned row presentation", () => {
  it("keeps a multiply-resolved Set target on its exact supplemental row", () => {
    const { drafts } = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: drafts,
    });

    expect(ordinaryMetadataRows()).toHaveLength(0);
    const supplemental = screen.getAllByTestId("details-occurrence-row");
    expect(supplemental).toHaveLength(2);
    const targetRow = supplemental.find(
      (row) =>
        row.dataset.occurrenceToken ===
        metadataOccurrenceIdToken(occurrenceA.id),
    )!;
    const siblingRow = supplemental.find(
      (row) =>
        row.dataset.occurrenceToken ===
        metadataOccurrenceIdToken(occurrenceB.id),
    )!;
    expect(targetRow.querySelector(".draft-original")).toHaveTextContent("300");
    expect(targetRow.querySelector(".draft-new")).toHaveTextContent("301");
    expect(targetRow).toHaveAttribute("data-has-exact-draft", "true");
    expect(targetRow).not.toHaveAttribute("data-readonly");
    expect(siblingRow).toHaveTextContent("72");
    expect(siblingRow).not.toHaveAttribute("data-readonly");
    expect(screen.queryByTestId("details-target-drafts-ambiguous")).toBeNull();

    fireEvent.contextMenu(targetRow);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard edit" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("edits and removes a supplemental row only through A's exact callback", () => {
    const view = renderPane({
      occurrences: [occurrenceA, occurrenceB],
    });
    const rowA = screen
      .getAllByTestId("details-occurrence-row")
      .find(
        (row) =>
          row.dataset.occurrenceToken ===
          metadataOccurrenceIdToken(occurrenceA.id),
      )!;
    fireEvent.contextMenu(rowA);
    fireEvent.click(screen.getByRole("button", { name: "Edit…" }));
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(300);
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "305" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      occurrenceA.id,
      expect.objectContaining({
        intent: "Set",
        value: { kind: "Integer", value: 305 },
      }),
    );
    expect(view.onRemoveMetadataFieldsV5).not.toHaveBeenCalled();

    fireEvent.contextMenu(rowA);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenLastCalledWith(
      occurrenceA.id,
      { intent: "Delete", value: null },
    );
    expect(view.onRemoveMetadataFieldsV5).not.toHaveBeenCalled();
  });

  it("shows supplemental Delete on A, filters has:edits exactly, and discards A", async () => {
    const { target, drafts } = targetDrafts(occurrenceA, {
      intent: "Delete",
      value: null,
    });
    const view = renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: drafts,
    });
    const rowA = screen
      .getAllByTestId("details-occurrence-row")
      .find(
        (row) =>
          row.dataset.occurrenceToken ===
          metadataOccurrenceIdToken(occurrenceA.id),
      )!;
    expect(rowA.querySelector(".draft-original")).toHaveTextContent("300");
    expect(rowA.querySelector(".draft-new")).toHaveTextContent("—");
    expect(screen.queryByTestId("details-target-drafts-ambiguous")).toBeNull();

    await userEvent.type(
      screen.getByTestId("details-search-input"),
      "has:edits",
    );
    const filtered = screen.getAllByTestId("details-occurrence-row");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]).toHaveAttribute(
      "data-occurrence-token",
      metadataOccurrenceIdToken(occurrenceA.id),
    );
    fireEvent.contextMenu(filtered[0]);
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it.each([
    ["ListAdd", "existing, kept, staged"],
    ["ListRemove", "kept"],
  ] as const)(
    "shows the effective supplemental %s value without changing intent",
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
      const rowA = screen
        .getAllByTestId("details-occurrence-row")
        .find(
          (row) =>
            row.dataset.occurrenceToken === metadataOccurrenceIdToken(listA.id),
        )!;
      expect(rowA.querySelector(".draft-new")).toHaveTextContent(expected);
    },
  );

  it("keeps a stale supplemental target unresolved without overlay", () => {
    const current = existingOccurrenceTargetFromOccurrence(occurrenceA);
    if (current.kind !== "targetable") throw new Error(current.reason);
    const staleStore = new TargetDraftEditsStore();
    staleStore.setMetadataTarget(
      photo.relative_path,
      {
        ...current.target,
        write_target: { ...current.target.write_target, group1: "IFD1" },
      },
      { intent: "Set", value: { kind: "Integer", value: 301 } },
    );
    renderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: staleStore.getMetadataFile(photo.relative_path),
    });
    expect(
      screen.getByTestId("details-target-drafts-ambiguous"),
    ).toBeInTheDocument();
    const staleRows = screen.getAllByTestId("details-occurrence-row");
    for (const row of staleRows) {
      expect(row).not.toHaveAttribute("data-has-exact-draft");
      expect(row.querySelector(".draft-new")).toBeNull();
    }
    expect(
      staleRows.find(
        (row) =>
          row.dataset.occurrenceToken ===
          metadataOccurrenceIdToken(occurrenceA.id),
      ),
    ).toHaveAttribute("data-readonly", "true");
    expect(
      staleRows.find(
        (row) =>
          row.dataset.occurrenceToken ===
          metadataOccurrenceIdToken(occurrenceB.id),
      ),
    ).not.toHaveAttribute("data-readonly");
    expect(ordinaryMetadataRows()).toHaveLength(0);
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
      screen
        .getAllByTestId("details-occurrence-row")
        .find((row) => row.dataset.occurrenceToken === siblingToken),
    ).not.toHaveAttribute("data-readonly");

    view.rerenderPane({
      occurrences: [occurrenceA, occurrenceB],
      targetDraftEdits: undefined,
    });
    const sibling = screen
      .getAllByTestId("details-occurrence-row")
      .find((row) => row.dataset.occurrenceToken === siblingToken)!;
    expect(sibling).not.toHaveAttribute("data-readonly");
    fireEvent.contextMenu(sibling);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
  });

  it("keeps a compatibility-omitted Delete visible with exact original, staged deletion, and individual discard", () => {
    const { target, drafts } = targetDrafts(occurrenceA, {
      intent: "Delete",
      value: null,
    });
    const view = renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: drafts,
    });

    const [row] = ordinaryMetadataRows();
    expect(row.querySelector(".draft-original")).toHaveTextContent("300");
    expect(row.querySelector(".draft-new")).toHaveTextContent("—");
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
    expect(screen.queryByTestId("details-target-drafts-ambiguous")).toBeNull();

    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("button", { name: "Discard edit" }));
    expect(view.onDiscardTargetPropertyDraft).toHaveBeenCalledWith(target);
  });

  it.each(["ListAdd", "ListRemove"] as const)(
    "keeps a compatibility-omitted %s target row visible",
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
      expect(ordinaryMetadataRows()).toHaveLength(1);
      expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
    },
  );

  it("does not duplicate a target-owned row already present in compatibility metadata", () => {
    const { drafts } = targetDrafts(occurrenceA, {
      intent: "Set",
      value: { kind: "Integer", value: 301 },
    });
    renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: drafts,
    });
    expect(ordinaryMetadataRows()).toHaveLength(1);
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
  });

  it("makes targetable compatibility-omitted occurrences exact-edit candidates", () => {
    renderPane({ occurrences: [occurrenceA, occurrenceB] });
    expect(ordinaryMetadataRows()).toHaveLength(0);
    const rows = screen.getAllByTestId("details-occurrence-row");
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
  ])("keeps a derived row read-only for %s", (label, item, reason) => {
    renderPane({ occurrences: [item] });
    const row =
      label === "unknown schema"
        ? screen.getByTestId("details-occurrence-row")
        : ordinaryMetadataRows()[0];
    expect(row).toHaveAttribute("data-readonly", "true");
    expect(row).toHaveAttribute("title", expect.stringMatching(reason));
    fireEvent.contextMenu(row);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("disables supplemental actions after a v5 persistence load failure", () => {
    renderPane({
      occurrences: [occurrenceA],
      targetDraftPersistence: { status: "load-failed", error: "bad v5" },
    });
    const row = ordinaryMetadataRows()[0];
    expect(row).toHaveAttribute("data-readonly", "true");
    expect(row).toHaveAttribute(
      "title",
      expect.stringContaining("persistence did not load safely"),
    );
  });

  it("keeps NewProperty and exact occurrence actions separate", () => {
    renderPane({
      occurrences: [occurrenceA],
      targetDraftEdits: (() => {
        const store = new TargetDraftEditsStore();
        store.setMetadataTarget(
          photo.relative_path,
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
        return store.getMetadataFile(photo.relative_path);
      })(),
    });
    const row = ordinaryMetadataRows()[0];
    expect(row).toHaveAttribute("data-readonly", "true");
  });

  it("keeps duplicate IDs and supplemental GPS read-only", () => {
    const duplicateView = renderPane({
      occurrences: [occurrenceA, structuredClone(occurrenceA)],
    });
    for (const row of screen.getAllByTestId("details-occurrence-row")) {
      expect(row).toHaveAttribute("data-readonly", "true");
      expect(row).toHaveAttribute(
        "title",
        expect.stringContaining("duplicated"),
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
    expect(screen.queryByTestId("details-occurrence-row")).toBeNull();
    const [gpsRow] = ordinaryMetadataRows();
    expect(gpsRow).toBeInTheDocument();
  });
});

describe("DetailsPane exact ordinary editor identity", () => {
  it("captures occurrence A, saves A, and refreshes A's changed value explicitly", async () => {
    const view = renderPane({
      occurrences: [occurrenceA],
    });
    openOrdinaryEditor();
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(300);

    const changedA: MetadataOccurrence = {
      ...occurrenceA,
      value: { kind: "Integer", value: 302 },
    };
    view.rerenderPane({
      occurrences: [changedA],
    });
    expect(screen.getByTestId("numeric-editor-input")).toHaveValue(302);
    fireEvent.change(screen.getByTestId("numeric-editor-input"), {
      target: { value: "303" },
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));
    expect(view.onSetExistingOccurrenceDraft).toHaveBeenCalledWith(
      occurrenceA.id,
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
    openOrdinaryEditor();
    expect(screen.getByTestId("numeric-editor-save")).toBeInTheDocument();

    view.rerenderPane({
      occurrences: nextOccurrences,
      targetDraftEdits: pending.drafts,
    });

    await waitFor(() =>
      expect(screen.queryByTestId("numeric-editor-overlay")).toBeNull(),
    );
    expect(screen.getByTestId("details-editor-unavailable")).toHaveTextContent(
      /nothing was saved|without saving/i,
    );
    expect(view.onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
    expect(view.onRemoveMetadataFieldsV5).not.toHaveBeenCalled();
    expect(pending.drafts).toEqual(originalDrafts);
  });

  it("keeps a staged Set as the seed and a staged Delete seeded from exact current value", () => {
    for (const [edit, expected] of [
      [{ intent: "Set", value: { kind: "Integer", value: 301 } }, 301],
      [{ intent: "Delete", value: null }, 300],
    ] as const) {
      const { drafts } = targetDrafts(occurrenceA, edit);
      const rendered = render(
        <DetailsPane
          photo={photo}

          occurrences={[occurrenceA]}
          targetDraftEdits={drafts}
          onRemoveMetadataFieldsV5={vi.fn()}
          onDiscardTargetDraftBatch={vi.fn()}
        />,
      );
      openOrdinaryEditor();
      expect(screen.getByTestId("numeric-editor-input")).toHaveValue(expected);
      rendered.unmount();
    }
  });

  it("routes individual GPS edits only through the target-aware GPS callback", async () => {
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
    expect(view.onSetGpsTargetDraftBatch).toHaveBeenCalledWith([
      expect.objectContaining({ id: GPS_IDS.latitude }),
    ]);
    expect(view.onRemoveMetadataFieldsV5).not.toHaveBeenCalled();
    expect(view.onSetExistingOccurrenceDraft).not.toHaveBeenCalled();
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
    store.setMetadataTarget(photo.relative_path, newTarget, {
      intent: "Set",
      value: { kind: "Text", value: "draft title" },
    });
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    const row = screen.getByText("draft title").closest("tr")!;
    fireEvent.contextMenu(row);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
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

  it("offers separate ordinary-row actions and edits only the exact New Property value", async () => {
    const { target, store } = stagedNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    const row = screen.getByText("draft title").closest("tr")!;
    fireEvent.contextMenu(row);
    expect(screen.getByRole("button", { name: "Edit…" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit destination…" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Discard edit" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
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
    expect(view.onSetGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(screen.queryByTestId("value-edit-input")).toBeNull();
  });

  it("edits an ordinary-row GPS New Property through its exact custom destination", async () => {
    const { target, store } = stagedGpsNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    const row = screen.getByText("GPSLatitude").closest("tr")!;
    fireEvent.contextMenu(row);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
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
    expect(view.onSetGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.queryByTestId("numeric-editor-input")).toBeNull(),
    );
  });

  it("keeps a custom GPS New Property editor open when async staging fails", async () => {
    const { target, store } = stagedGpsNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    view.onSetNewPropertyDraft.mockResolvedValueOnce(false);
    fireEvent.contextMenu(screen.getByText("GPSLatitude").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/remains open/i),
    );
    expect(view.onSetNewPropertyDraft).toHaveBeenCalledWith(target, {
      intent: "Set",
      value: { kind: "Real", value: 51.5 },
    });
    expect(screen.getByTestId("numeric-editor-input")).toBeInTheDocument();
    expect(view.onSetGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
  });

  it("keeps the value editor open when async staging fails", async () => {
    const { store } = stagedNewProperty();
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    view.onSetNewPropertyDraft.mockResolvedValueOnce(false);
    fireEvent.contextMenu(screen.getByText("draft title").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
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
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    fireEvent.contextMenu(screen.getByText("draft title").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));
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
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    fireEvent.contextMenu(screen.getByText("draft title").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));

    const sibling = {
      ...structuredClone(target),
      write_target: { ...target.write_target, group1: "XMP-sibling" },
    };
    const replacementStore = new TargetDraftEditsStore();
    replacementStore.setMetadataTarget(photo.relative_path, sibling, edit);
    view.rerenderPane({
      occurrences: [],
      targetDraftEdits: replacementStore.getMetadataFile(photo.relative_path),
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
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    fireEvent.contextMenu(screen.getByText("GPSLatitude").closest("tr")!);
    await userEvent.click(screen.getByRole("button", { name: "Edit…" }));

    const defaultSibling = {
      ...structuredClone(target),
      write_target: { ...target.write_target, group1: "GPS" },
    };
    const replacementStore = new TargetDraftEditsStore();
    replacementStore.setMetadataTarget(
      photo.relative_path,
      defaultSibling,
      edit,
    );
    view.rerenderPane({
      occurrences: [],
      targetDraftEdits: replacementStore.getMetadataFile(photo.relative_path),
    });
    fireEvent.click(screen.getByTestId("numeric-editor-save"));

    expect(view.onSetNewPropertyDraft).not.toHaveBeenCalled();
    expect(view.onSetGpsTargetDraftBatch).not.toHaveBeenCalled();
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
    store.setMetadataTarget(photo.relative_path, sibling, edit);
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    const items = screen.getAllByTestId("details-unresolved-target-item");
    const siblingItem = items.find((item) =>
      item.textContent?.includes("XMP-sibling"),
    )!;
    await userEvent.click(
      siblingItem.querySelector("button") as HTMLButtonElement,
    );
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
    store.setMetadataTarget(photo.relative_path, sibling, edit);
    const view = renderPane({
      occurrences: [],
      targetDraftEdits: store.getMetadataFile(photo.relative_path),
    });
    const siblingItem = screen
      .getAllByTestId("details-unresolved-target-item")
      .find((item) => item.textContent?.includes("CustomGPS2"))!;
    await userEvent.click(
      siblingItem.querySelector("button") as HTMLButtonElement,
    );
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
    expect(view.onSetGpsTargetDraftBatch).not.toHaveBeenCalled();
    expect(view.onReplaceNewPropertyDraftTarget).not.toHaveBeenCalled();
  });
});

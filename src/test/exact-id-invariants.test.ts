import { beforeEach, describe, expect, it } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataTagOutcome,
  MetadataValue,
  SchemaDefinitionId,
  SortConfig,
  VisibleColumn,
} from "../types";
import {
  DraftEditsStore,
  metadataDraftsFromWire,
  metadataDraftsToWire,
} from "../types";
import {
  COLUMN_CONFIG_KEY,
  loadColumnConfig,
  saveColumnConfig,
} from "../utils/columnConfig";
import { metadataCollection } from "../utils/metadataCollection";
import {
  schemaDefinitionIdEquals,
  schemaDefinitionIdToken,
} from "../utils/schemaDefinitionId";
import { mergeVerifyOutcomes } from "../utils/verifyOutcomes";
import {
  toSearchDraftEntries,
  toSearchMetadataState,
} from "../hooks/useSearchWorker";

const text = (value: string): MetadataValue => ({ kind: "Text", value });
const edit = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: text(value),
});

const collisionA: SchemaDefinitionId = {
  table: "BMP::Main",
  tag_id: "0",
};
const collisionB: SchemaDefinitionId = {
  table: "BMP::OS2",
  tag_id: "0",
};
const omittedIndex: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "513",
};
const zeroIndex: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "513",
  index: 0,
};

function outcome(id: SchemaDefinitionId, value: string): MetadataTagOutcome {
  return {
    id,
    display_name: "File:BMPVersion",
    kind: "Mismatch",
    sent: text(value),
    before: null,
    observed: text("other"),
    message: null,
  };
}

describe("exact SchemaDefinitionId invariants", () => {
  beforeEach(() => localStorage.clear());

  it("keeps same-friendly-name metadata definitions and index variants distinct", () => {
    const values = metadataCollection([
      { id: collisionA, value: text("Windows V3") },
      { id: collisionB, value: text("OS/2 V1") },
      { id: omittedIndex, value: text("omitted") },
      { id: zeroIndex, value: text("zero") },
    ]);

    expect(Object.values(values).map(({ id }) => id)).toEqual([
      collisionA,
      collisionB,
      omittedIndex,
      zeroIndex,
    ]);
    expect(Object.keys(values)).toHaveLength(4);
  });

  it("round-trips draft entry arrays without using identity as JSON keys", () => {
    const wire = {
      "photo.bmp": [
        { id: collisionA, edit: edit("Windows V3") },
        { id: collisionB, edit: edit("OS/2 V1") },
        { id: omittedIndex, edit: edit("omitted") },
        { id: zeroIndex, edit: edit("zero") },
      ],
    };

    const internal = metadataDraftsFromWire(JSON.parse(JSON.stringify(wire)));
    const serialized = JSON.stringify(metadataDraftsToWire(internal));
    const restored = JSON.parse(serialized) as typeof wire;

    expect(restored).toEqual(wire);
    expect(restored["photo.bmp"]).toHaveLength(4);
    expect(restored["photo.bmp"].some(({ id }) => id.index === 0)).toBe(true);
    expect(restored["photo.bmp"].some(({ id }) => id.index === undefined)).toBe(
      true,
    );
  });

  it("preserves exact IDs in visible columns and image sort keys", () => {
    const visibleColumns: VisibleColumn[] = [
      { kind: "image", id: collisionA },
      { kind: "image", id: collisionB },
      { kind: "image", id: omittedIndex },
      { kind: "image", id: zeroIndex },
    ];
    const sortConfig: SortConfig = {
      primary: { kind: "image", id: collisionA, direction: "asc" },
      secondary: { kind: "image", id: collisionB, direction: "desc" },
    };

    saveColumnConfig({ visibleColumns, sortConfig, columnWidths: {} });
    const restored = loadColumnConfig();

    expect(restored.visibleColumns).toEqual(visibleColumns);
    expect(restored.sortConfig).toEqual(sortConfig);
  });

  it("resets legacy image columns and sort keys instead of guessing", () => {
    localStorage.setItem(
      COLUMN_CONFIG_KEY,
      JSON.stringify({
        version: 1,
        visibleColumns: [{ kind: "image", key: "File:BMPVersion" }],
        sortConfig: {
          primary: {
            kind: "image",
            key: "File:BMPVersion",
            direction: "asc",
          },
          secondary: null,
        },
        columnWidths: {},
      }),
    );

    const restored = loadColumnConfig();
    expect(restored.visibleColumns).not.toContainEqual({
      kind: "image",
      key: "File:BMPVersion",
    });
    expect(restored.sortConfig).toEqual({ primary: null, secondary: null });
  });

  it("posts structured worker metadata and draft entries", () => {
    const metadata = metadataCollection([
      { id: collisionA, value: text("Windows V3") },
      { id: collisionB, value: text("OS/2 V1") },
    ]);
    const drafts = metadataDraftsFromWire({
      "photo.bmp": [
        { id: collisionA, edit: edit("A") },
        { id: collisionB, edit: edit("B") },
      ],
    });

    expect(toSearchMetadataState(metadata)).toEqual([
      { id: collisionA, value: text("Windows V3") },
      { id: collisionB, value: text("OS/2 V1") },
    ]);
    expect(toSearchDraftEntries(drafts["photo.bmp"])).toEqual([
      { id: collisionA, edit: edit("A") },
      { id: collisionB, edit: edit("B") },
    ]);
  });

  it("handles apply outcomes and draft pruning by exact ID", () => {
    const store = new DraftEditsStore();
    store.resetMetadata({
      "photo.bmp": metadataDraftsFromWire({
        "photo.bmp": [
          { id: collisionA, edit: edit("A") },
          { id: collisionB, edit: edit("B") },
        ],
      })["photo.bmp"],
    });
    store.pruneTags("photo.bmp", [collisionA]);
    expect(Object.values(store.getMetadataFile("photo.bmp") ?? {})).toEqual([
      { id: collisionB, edit: edit("B") },
    ]);

    const merged = mergeVerifyOutcomes({}, "photo.bmp", [
      outcome(collisionA, "A"),
      outcome(collisionB, "B"),
    ]);
    expect(merged["photo.bmp"].map(({ id }) => id)).toEqual([
      collisionA,
      collisionB,
    ]);
  });

  it("never equates an omitted index with index zero", () => {
    expect(schemaDefinitionIdEquals(omittedIndex, zeroIndex)).toBe(false);
    expect(schemaDefinitionIdToken(omittedIndex)).not.toBe(
      schemaDefinitionIdToken(zeroIndex),
    );
  });
});

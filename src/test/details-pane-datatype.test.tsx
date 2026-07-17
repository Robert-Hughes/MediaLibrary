import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type {
  MetadataDraftEdit,
  MetadataOccurrence,
  MetadataValue,
  SchemaDefinitionId,
  TagInfo,
  TagKind,
} from "../types";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { metadataCollection } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { makePhoto } from "./factories";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const photo = makePhoto({ relative_path: "datatype.jpg" });

function schemaId(tagId: string): SchemaDefinitionId {
  return { table: "Test::Datatype", tag_id: tagId };
}

function info(
  id: SchemaDefinitionId,
  kind: TagKind,
  name = id.tag_id,
): TagInfo {
  return {
    id,
    group: "Test",
    name,
    writable: true,
    kind,
    description: null,
  };
}

function occurrence(
  tagInfo: TagInfo,
  value: MetadataValue,
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: `TEST-${tagInfo.id.tag_id}`,
      tag_id: tagInfo.id.tag_id,
      copy: 0,
    },
    value,
    tag_info: tagInfo,
    write_target: { group1: "Test", tag_name: tagInfo.name },
  };
}

function exactDraft(source: MetadataOccurrence, edit: MetadataDraftEdit) {
  const target = existingOccurrenceTargetFromOccurrence(source);
  if (target.kind !== "targetable") throw new Error(target.reason);
  const store = new TargetDraftEditsStore();
  store.setMetadataTarget(photo.relative_path, target.target, edit);
  return store.getMetadataFile(photo.relative_path);
}

function newPropertyDraft(id: SchemaDefinitionId, edit: MetadataDraftEdit) {
  const store = new TargetDraftEditsStore();
  store.setMetadataTarget(
    photo.relative_path,
    { kind: "NewProperty", schema_id: id },
    edit,
  );
  return store.getMetadataFile(photo.relative_path);
}

function renderExisting(options: {
  id: SchemaDefinitionId;
  kind: TagKind;
  value: MetadataValue;
  edit?: MetadataDraftEdit;
}) {
  const tag = info(options.id, options.kind);
  _setTagInfoCacheEntry(options.id, tag);
  const item = occurrence(tag, options.value);
  render(
    <DetailsPane
      photo={photo}
      metadata={metadataCollection([{ id: options.id, value: options.value }])}
      occurrences={[item]}
      targetDraftEdits={
        options.edit === undefined ? undefined : exactDraft(item, options.edit)
      }
      targetDraftPersistence={{ status: "ready" }}
      onSetExistingOccurrenceDraft={vi.fn()}
      onRemoveMetadataFieldsV5={vi.fn()}
      onSetNewPropertyDraft={vi.fn()}
      onDiscardTargetPropertyDraft={vi.fn()}
      onDiscardTargetDraftBatch={vi.fn()}
    />,
  );
  return rowFor(options.id);
}

function renderNewProperty(options: {
  id: SchemaDefinitionId;
  kind: TagKind;
  edit: MetadataDraftEdit;
}) {
  const tag = info(options.id, options.kind);
  _setTagInfoCacheEntry(options.id, tag);
  render(
    <DetailsPane
      photo={photo}
      metadata={{}}
      occurrences={[]}
      targetDraftEdits={newPropertyDraft(options.id, options.edit)}
      targetDraftPersistence={{ status: "ready" }}
      onSetExistingOccurrenceDraft={vi.fn()}
      onRemoveMetadataFieldsV5={vi.fn()}
      onSetNewPropertyDraft={vi.fn()}
      onDiscardTargetPropertyDraft={vi.fn()}
      onDiscardTargetDraftBatch={vi.fn()}
    />,
  );
  return rowFor(options.id);
}

function rowFor(id: SchemaDefinitionId): HTMLElement {
  const token = schemaDefinitionIdToken(id);
  const row = screen
    .getAllByTestId("details-row")
    .find((candidate) => candidate.dataset.rowKey === token);
  if (!row) throw new Error(`Details row not found for ${token}`);
  return row;
}

function badgeCode(
  row: HTMLElement,
  variant: "schema" | "value" | "draft",
): string | null {
  return (
    within(row)
      .queryByTestId(`datatype-badge-${variant}`)
      ?.getAttribute("data-code") ?? null
  );
}

function expectBadges(
  row: HTMLElement,
  expected: {
    schema: string | null;
    value: string | null;
    draft: string | null;
  },
): void {
  expect(badgeCode(row, "schema")).toBe(expected.schema);
  expect(badgeCode(row, "value")).toBe(expected.value);
  expect(badgeCode(row, "draft")).toBe(expected.draft);
}

beforeEach(() => _clearTagInfoCache());
afterEach(() => {
  cleanup();
  _clearTagInfoCache();
});

describe("DetailsPane target-aware datatype badges", () => {
  it("renders matching schema and runtime types without a divergence badge", () => {
    const row = renderExisting({
      id: schemaId("matching"),
      kind: { kind: "Text" },
      value: { kind: "Text", value: "value" },
    });
    expectBadges(row, { schema: "S", value: null, draft: null });
  });

  it("renders a runtime badge when schema and runtime types differ", () => {
    const row = renderExisting({
      id: schemaId("runtime-differs"),
      kind: { kind: "Text" },
      value: { kind: "Integer", value: 42 },
    });
    expectBadges(row, { schema: "S", value: "I", draft: null });
  });

  it("suppresses divergence badges when schema, runtime and exact draft all match", () => {
    const row = renderExisting({
      id: schemaId("all-match"),
      kind: { kind: "Text" },
      value: { kind: "Text", value: "before" },
      edit: { intent: "Set", value: { kind: "Text", value: "after" } },
    });
    expectBadges(row, { schema: "S", value: null, draft: null });
    expect(row.querySelector(".draft-new")).toHaveTextContent("after");
  });

  it("derives the draft badge from the exact target's semantic edit", () => {
    const row = renderExisting({
      id: schemaId("draft-differs"),
      kind: { kind: "Text" },
      value: { kind: "Text", value: "before" },
      edit: { intent: "Set", value: { kind: "Integer", value: 7 } },
    });
    expectBadges(row, { schema: "S", value: null, draft: "I" });
  });

  it("shows runtime and draft badges when they match each other but not the schema", () => {
    const row = renderExisting({
      id: schemaId("runtime-draft-match"),
      kind: { kind: "Text" },
      value: { kind: "Integer", value: 42 },
      edit: { intent: "Set", value: { kind: "Integer", value: 7 } },
    });
    expectBadges(row, { schema: "S", value: "I", draft: "I" });
  });

  it("shows schema, runtime and draft badges when all three types differ", () => {
    const row = renderExisting({
      id: schemaId("all-different"),
      kind: { kind: "Text" },
      value: { kind: "Integer", value: 42 },
      edit: { intent: "Set", value: { kind: "Bool", value: true } },
    });
    expectBadges(row, { schema: "S", value: "I", draft: "B" });
  });

  it("treats an integer runtime value as compatible with an integer schema", () => {
    const row = renderExisting({
      id: schemaId("integer-compatible"),
      kind: { kind: "Integer", data: { min: null, max: null } },
      value: { kind: "Integer", value: 42 },
    });
    expectBadges(row, { schema: "I", value: null, draft: null });
  });

  for (const listKind of ["Bag", "Seq", "Alt"] as const) {
    it(`renders matching ${listKind} schema and list values`, () => {
      const code = { Bag: "[B]", Seq: "[S]", Alt: "[A]" }[listKind];
      const row = renderExisting({
        id: schemaId(`list-${listKind}`),
        kind: { kind: listKind, data: { kind: "Text" } },
        value: {
          kind: "List",
          value: {
            list_kind: listKind,
            items: [{ kind: "Text", value: "one" }],
          },
        },
      });
      expectBadges(row, { schema: code, value: null, draft: null });
    });
  }

  it("shows a scalar runtime badge under a list schema", () => {
    const row = renderExisting({
      id: schemaId("scalar-under-list"),
      kind: { kind: "Bag", data: { kind: "Text" } },
      value: { kind: "Text", value: "scalar" },
    });
    expectBadges(row, { schema: "[B]", value: "S", draft: null });
  });

  it("renders LangAlt schema and runtime values", () => {
    const row = renderExisting({
      id: schemaId("lang-alt"),
      kind: { kind: "LangAlt" },
      value: { kind: "LangAlt", value: { "x-default": "Hello", en: "Hello" } },
    });
    expectBadges(row, { schema: "LA", value: null, draft: null });
  });

  for (const temporal of [
    {
      name: "date",
      kind: { kind: "Date" } as TagKind,
      value: {
        kind: "Date",
        value: { year: 2026, month: 7, day: 17 },
      } as MetadataValue,
      code: "D",
    },
    {
      name: "time",
      kind: { kind: "Time" } as TagKind,
      value: {
        kind: "Time",
        value: {
          hour: 8,
          minute: 30,
          second: 0,
          subsecond: null,
          offset: null,
        },
      } as MetadataValue,
      code: "T",
    },
    {
      name: "datetime",
      kind: { kind: "DateTime" } as TagKind,
      value: {
        kind: "DateTime",
        value: {
          date: { year: 2026, month: 7, day: 17 },
          time: {
            hour: 8,
            minute: 30,
            second: 0,
            subsecond: null,
            offset: null,
          },
        },
      } as MetadataValue,
      code: "DT",
    },
  ]) {
    it(`renders matching ${temporal.name} schema and runtime values`, () => {
      const row = renderExisting({
        id: schemaId(temporal.name),
        kind: temporal.kind,
        value: temporal.value,
      });
      expectBadges(row, {
        schema: temporal.code,
        value: null,
        draft: null,
      });
    });
  }

  it("treats an Unknown schema as no schema while showing the runtime type", () => {
    const row = renderExisting({
      id: schemaId("unknown-schema"),
      kind: { kind: "Unknown" },
      value: { kind: "Text", value: "raw" },
    });
    expectBadges(row, { schema: null, value: "S", draft: null });
  });

  it("renders Null runtime and Delete draft presentation without a draft datatype badge", () => {
    const nullRow = renderExisting({
      id: schemaId("null-runtime"),
      kind: { kind: "Text" },
      value: { kind: "Null" },
    });
    expectBadges(nullRow, { schema: "S", value: "∅", draft: null });
    cleanup();
    _clearTagInfoCache();

    const deleteRow = renderExisting({
      id: schemaId("delete-draft"),
      kind: { kind: "Text" },
      value: { kind: "Text", value: "before" },
      edit: { intent: "Delete", value: null },
    });
    expectBadges(deleteRow, { schema: "S", value: null, draft: null });
    expect(deleteRow.querySelector(".draft-new")).toHaveTextContent("—");
  });

  it("renders a NewProperty target draft and its semantic datatype", () => {
    const row = renderNewProperty({
      id: schemaId("new-property"),
      kind: { kind: "Text" },
      edit: { intent: "Set", value: { kind: "Integer", value: 9 } },
    });
    expectBadges(row, { schema: "S", value: null, draft: "I" });
    expect(row.querySelector(".draft-new")).toHaveTextContent("9");
  });

  it("renders an exact ExistingOccurrence target draft on the authoritative row", () => {
    const row = renderExisting({
      id: schemaId("exact-existing"),
      kind: { kind: "Real" },
      value: { kind: "Real", value: 1.5 },
      edit: { intent: "Set", value: { kind: "Text", value: "different" } },
    });
    expectBadges(row, { schema: "R", value: null, draft: "S" });
    expect(row.querySelector(".draft-new")).toHaveTextContent("different");
  });
});

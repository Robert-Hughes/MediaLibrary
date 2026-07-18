import { describe, expect, it } from "vitest";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataOccurrenceId,
  MetadataTargetDraftEntry,
  MetadataValue,
  MetadataWriteTarget,
  SchemaDefinitionId,
  TagInfo,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { buildOccurrenceDetailsPresentation } from "../details/occurrenceDetailsPresentation";
import {
  existingOccurrenceTargetFromOccurrence,
  metadataDraftTargetSlotToken,
} from "../utils/metadataDraftTarget";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";

const schema: SchemaDefinitionId = {
  table: "Exif::Main",
  tag_id: "282",
};

const otherSchema: SchemaDefinitionId = {
  table: "XMP::Main",
  tag_id: "Title",
};

function tagInfo(
  id: SchemaDefinitionId = schema,
  overrides: Partial<TagInfo> = {},
): TagInfo {
  return {
    id: structuredClone(id),
    group: "SchemaGroup",
    name: id.tag_id === "282" ? "XResolution" : "Title",
    writable: true,
    kind: { kind: "Integer", data: { min: null, max: null } },
    description: null,
    ...overrides,
  };
}

function occurrenceId(
  path: string,
  copy = 0,
  document: string | null = null,
): MetadataOccurrenceId {
  return {
    document,
    path,
    runtime_tag_id: schema.tag_id,
    tag_id_scope: {
      table: schema.table,
      tag_id: schema.tag_id,
      index: null,
    },
    copy,
  };
}

function selector(
  group1: string,
  tagName = "XResolution",
): MetadataWriteTarget {
  return {
    group1,
    group7: "ID-282",
    tag_name: tagName,
  };
}

function occurrence(
  path: string,
  value: MetadataValue = { kind: "Integer", value: 300 },
  overrides: Partial<MetadataOccurrence> = {},
): MetadataOccurrence {
  const observed = selector("IFD0");
  return {
    id: occurrenceId(path),
    schema_id: structuredClone(schema),
    value: structuredClone(value),
    tag_info: tagInfo(),
    observed_selector: observed,
    write_target: structuredClone(observed),
    ...overrides,
  };
}

function exactTarget(
  value: MetadataOccurrence,
): Extract<MetadataDraftTarget, { kind: "ExistingOccurrence" }> {
  const result = existingOccurrenceTargetFromOccurrence(value);
  if (result.kind !== "targetable") throw new Error(result.reason);
  return result.target;
}

function edit(
  value: MetadataValue | null = { kind: "Integer", value: 301 },
  intent: MetadataDraftEdit["intent"] = "Set",
): MetadataDraftEdit {
  return { value, intent };
}

function collection(
  entries: readonly MetadataTargetDraftEntry[],
): TargetDraftCollection {
  return Object.fromEntries(
    entries.map((entry) => [metadataDraftTargetSlotToken(entry.target), entry]),
  );
}

function newTarget(
  id: SchemaDefinitionId,
  group1: string,
  tagName = "Title",
): Extract<MetadataDraftTarget, { kind: "NewProperty" }> {
  return {
    kind: "NewProperty",
    schema_id: structuredClone(id),
    write_target: {
      group1,
      group7: `ID-${id.tag_id}`,
      tag_name: tagName,
    },
  };
}

describe("buildOccurrenceDetailsPresentation", () => {
  it("creates one independent row for every authoritative occurrence", () => {
    const first = occurrence("JPEG-APP1-IFD0");
    const second = occurrence("JPEG-APP1-IFD1", first.value, {
      id: occurrenceId("JPEG-APP1-IFD1", 1),
      observed_selector: selector("IFD1"),
      write_target: selector("IFD1"),
    });

    const result = buildOccurrenceDetailsPresentation({
      occurrences: [first, second],
    });

    expect(result.groups.flatMap((group) => group.rows)).toHaveLength(2);
    expect(
      result.groups.flatMap((group) => group.rows).map((row) => row.kind),
    ).toEqual(["ExistingOccurrenceRow", "ExistingOccurrenceRow"]);
    expect(result.groups.map((group) => group.name)).toEqual(["IFD0", "IFD1"]);
  });

  it("keeps equal same-schema occurrences distinct inside one group", () => {
    const first = occurrence("JPEG-APP1-IFD0");
    const second = occurrence("JPEG-APP1-IFD1", first.value, {
      id: occurrenceId("JPEG-APP1-IFD1", 1),
    });

    const rows = buildOccurrenceDetailsPresentation({
      occurrences: [second, first],
    }).groups[0].rows;

    expect(rows).toHaveLength(2);
    expect(rows[0].key).not.toBe(rows[1].key);
    expect(rows.every((row) => row.kind === "ExistingOccurrenceRow")).toBe(
      true,
    );
    expect(rows.map((row) => row.originQualifier)).toEqual([
      "JPEG-APP1-IFD0",
      "JPEG-APP1-IFD1 · Copy1",
    ]);
  });

  it("uses the observed family-1 group before the schema group", () => {
    const result = buildOccurrenceDetailsPresentation({
      occurrences: [
        occurrence("runtime", undefined, {
          tag_info: tagInfo(schema, { group: "SchemaGroup" }),
          observed_selector: selector("RuntimeGroup"),
          write_target: selector("RuntimeGroup"),
        }),
      ],
    });

    expect(result.groups[0].name).toBe("RuntimeGroup");
    expect(result.groups[0].rows[0].groupSource).toBe("observed-selector");
  });

  it("uses the schema group, then a table-based fallback which sorts last", () => {
    const schemaGrouped = occurrence("known", undefined, {
      observed_selector: null,
      write_target: null,
      tag_info: tagInfo(schema, { group: "KnownGroup" }),
    });
    const unresolved = occurrence(
      "unknown",
      { kind: "Text", value: "raw" },
      {
        schema_id: { table: "MakerNotes::Vendor", tag_id: "0x01" },
        tag_info: null,
        observed_selector: null,
        write_target: null,
      },
    );

    const result = buildOccurrenceDetailsPresentation({
      occurrences: [unresolved, schemaGrouped],
    });

    expect(result.groups.map((group) => group.name)).toEqual([
      "KnownGroup",
      "Unknown (MakerNotes::Vendor)",
    ]);
    expect(result.groups[1].fallback).toBe(true);
  });

  it("uses the observed tag name before schema diagnostics for unresolved schemas", () => {
    const unresolved = occurrence(
      "unknown",
      { kind: "Text", value: "raw" },
      {
        tag_info: null,
        observed_selector: selector("MakerNotes", "RuntimeName"),
        write_target: null,
      },
    );

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [unresolved],
    }).groups[0].rows[0];

    expect(row.label).toBe("RuntimeName");
    expect(row.kind).toBe("ExistingOccurrenceRow");
    if (row.kind !== "ExistingOccurrenceRow") throw new Error("wrong row kind");
    expect(row.targetability.kind).toBe("read-only");
  });

  it("marks duplicate occurrence IDs and presents their stored operation separately", () => {
    const first = occurrence("duplicate");
    const second = structuredClone(first);
    second.value = { kind: "Integer", value: 72 };
    const target = exactTarget(first);

    const result = buildOccurrenceDetailsPresentation({
      occurrences: [first, second],
      targetDrafts: collection([{ target, edit: edit() }]),
    });
    const rows = result.groups.flatMap((group) => group.rows);
    const existingRows = rows.filter(
      (row) => row.kind === "ExistingOccurrenceRow",
    );
    const warningRows = rows.filter(
      (row) => row.kind === "MissingOccurrenceDraftRow",
    );

    expect(existingRows).toHaveLength(2);
    expect(
      existingRows.every(
        (row) =>
          row.kind === "ExistingOccurrenceRow" && row.duplicateOccurrenceId,
      ),
    ).toBe(true);
    expect(warningRows).toHaveLength(1);
    expect(warningRows[0].status.code).toBe("duplicate-occurrence-id");
  });

  it("attaches a draft only when the complete current target matches exactly", () => {
    const current = occurrence("exact");
    const target = exactTarget(current);
    const draft = { target, edit: edit() };

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([draft]),
    }).groups[0].rows[0];

    expect(row.kind).toBe("ExistingOccurrenceRow");
    if (row.kind !== "ExistingOccurrenceRow") throw new Error("wrong row kind");
    expect(row.draft).toEqual(draft);
    expect(row.staleDraft).toBeNull();
    expect(row.status.code).toBe("edited");
  });

  it("retains a stale target snapshot without overlaying its staged value", () => {
    const current = occurrence("stale");
    const staleTarget = exactTarget(current);
    staleTarget.write_target.group1 = "IFD1";
    const staleDraft = { target: staleTarget, edit: edit() };

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([staleDraft]),
    }).groups[0].rows[0];

    expect(row.kind).toBe("ExistingOccurrenceRow");
    if (row.kind !== "ExistingOccurrenceRow") throw new Error("wrong row kind");
    expect(row.draft).toBeNull();
    expect(row.staleDraft).toEqual(staleDraft);
    expect(row.status.code).toBe("stale-target");
    expect(row.stagedValue).toBeNull();
  });

  it("renders a missing occurrence draft as a target-only warning row", () => {
    const missing = occurrence("missing");
    const target = exactTarget(missing);

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [],
      targetDrafts: collection([{ target, edit: edit() }]),
    }).groups[0].rows[0];

    expect(row.kind).toBe("MissingOccurrenceDraftRow");
    expect(row.group).toBe("IFD0");
    expect(row.status.code).toBe("missing-occurrence");
  });

  it("places a New Property in its custom destination group", () => {
    const target = newTarget(otherSchema, "CustomDestination");
    const info = tagInfo(otherSchema, {
      group: "SchemaDefault",
      name: "Title",
      kind: { kind: "Text" },
    });

    const result = buildOccurrenceDetailsPresentation({
      occurrences: [],
      targetDrafts: collection([
        { target, edit: edit({ kind: "Text", value: "Draft title" }) },
      ]),
      tagInfos: { [schemaDefinitionIdToken(otherSchema)]: info },
    });

    expect(result.groups[0].name).toBe("CustomDestination");
    const row = result.groups[0].rows[0];
    expect(row.kind).toBe("NewPropertyRow");
    expect(row.status.code).toBe("new");
    expect(row.label).toBe("Title");
  });

  it("keeps same-schema New Properties at separate destinations independent", () => {
    const first = newTarget(otherSchema, "XMP-dc");
    const second = newTarget(otherSchema, "XMP-photoshop");
    const entries = [
      { target: first, edit: edit({ kind: "Text", value: "One" }) },
      { target: second, edit: edit({ kind: "Text", value: "Two" }) },
    ];

    const result = buildOccurrenceDetailsPresentation({
      occurrences: [],
      targetDrafts: collection(entries),
    });

    expect(result.groups.map((group) => group.name)).toEqual([
      "XMP-dc",
      "XMP-photoshop",
    ]);
    expect(
      result.groups.flatMap((group) => group.rows).map((row) => row.key),
    ).toHaveLength(2);
  });

  it("marks an occupied New Property destination without converting its row kind", () => {
    const target = newTarget(otherSchema, "IFD0", "Title");
    const occupied = occurrence(
      "occupied",
      { kind: "Text", value: "Current" },
      {
        schema_id: structuredClone(otherSchema),
        tag_info: tagInfo(otherSchema, { kind: { kind: "Text" } }),
        observed_selector: structuredClone(target.write_target),
        write_target: structuredClone(target.write_target),
      },
    );

    const rows = buildOccurrenceDetailsPresentation({
      occurrences: [occupied],
      targetDrafts: collection([
        { target, edit: edit({ kind: "Text", value: "New" }) },
      ]),
    }).groups.flatMap((group) => group.rows);
    const newRow = rows.find((row) => row.kind === "NewPropertyRow");

    expect(newRow?.kind).toBe("NewPropertyRow");
    expect(newRow?.status.code).toBe("destination-occupied");
  });

  it("builds complete searchable diagnostics for values, statuses and exact identities", () => {
    const current = occurrence("JPEG-APP1-IFD0", {
      kind: "Integer",
      value: 300,
    });
    const target = exactTarget(current);

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([{ target, edit: edit() }]),
    }).groups[0].rows[0];

    expect(row.searchText).toContain("XResolution");
    expect(row.searchText).toContain("IFD0");
    expect(row.searchText).toContain("300");
    expect(row.searchText).toContain("301");
    expect(row.searchText).toContain("Edited");
    expect(row.searchText).toContain("Exif::Main");
    expect(row.searchText).toContain("JPEG-APP1-IFD0");
    expect(row.searchText).toContain("ID-282");
  });

  it("orders deterministically and does not mutate any input", () => {
    const zed = occurrence("z", undefined, {
      tag_info: tagInfo(schema, { name: "Zed" }),
      observed_selector: selector("B", "Zed"),
      write_target: selector("B", "Zed"),
    });
    const alpha = occurrence("a", undefined, {
      tag_info: tagInfo(schema, { name: "Alpha" }),
      observed_selector: selector("A", "Alpha"),
      write_target: selector("A", "Alpha"),
    });
    const input = {
      occurrences: [zed, alpha],
      targetDrafts: collection([
        { target: newTarget(otherSchema, "C"), edit: edit() },
      ]),
    };
    const snapshot = structuredClone(input);

    const first = buildOccurrenceDetailsPresentation(input);
    const second = buildOccurrenceDetailsPresentation({
      ...input,
      occurrences: [...input.occurrences].reverse(),
    });

    expect(first.groups.map((group) => group.name)).toEqual(["A", "B", "C"]);
    expect(second.groups.map((group) => group.name)).toEqual(["A", "B", "C"]);
    expect(input).toEqual(snapshot);
  });
});

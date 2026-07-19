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
import { classifyNewPropertyDestination } from "../utils/newPropertyDestinationSafety";

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
    expect(
      result.groups
        .flatMap((group) => group.rows)
        .map((row) => row.originQualifier),
    ).toEqual([null, null]);
  });

  it("does not qualify a sole occurrence merely because it has a nonzero copy", () => {
    const row = buildOccurrenceDetailsPresentation({
      occurrences: [
        occurrence("JPEG-APP1-IFD1", undefined, {
          id: occurrenceId("JPEG-APP1-IFD1", 1),
          observed_selector: selector("IFD1", "ResolutionUnit"),
          write_target: selector("IFD1", "ResolutionUnit"),
          tag_info: tagInfo(schema, { name: "ResolutionUnit" }),
        }),
      ],
    }).groups[0].rows[0];

    expect(row.originQualifier).toBeNull();
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
    expect(new Set(rows.map((row) => row.originQualifier)).size).toBe(2);
  });

  it("presents one complete writable LangAlt occurrence as one row", () => {
    const langAltSchema: SchemaDefinitionId = {
      table: "XMP::dc",
      tag_id: "description",
    };
    const writeTarget: MetadataWriteTarget = {
      group1: "XMP-dc",
      group7: "ID-description",
      tag_name: "Description",
    };
    const complete = occurrence(
      "JPEG-APP1-XMP",
      {
        kind: "LangAlt",
        value: {
          "x-default": "Default",
          en: "English",
          fr: "Francais",
        },
      },
      {
        id: {
          ...occurrenceId("JPEG-APP1-XMP"),
          runtime_tag_id: "description",
          tag_id_scope: {
            table: langAltSchema.table,
            tag_id: langAltSchema.tag_id,
            index: null,
          },
        },
        schema_id: langAltSchema,
        tag_info: tagInfo(langAltSchema, {
          group: "XMP-dc",
          name: "Description",
          kind: { kind: "LangAlt" },
        }),
        observed_selector: writeTarget,
        write_target: structuredClone(writeTarget),
      },
    );

    const rows = buildOccurrenceDetailsPresentation({
      occurrences: [complete],
    }).groups.flatMap((group) => group.rows);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "ExistingOccurrenceRow",
      label: "Description",
      currentValue: "x-default: Default; en: English; fr: Francais",
      targetability: { kind: "targetable" },
    });
  });

  it("extends colliding human-readable qualifiers with runtime identity", () => {
    const first = occurrence("JPEG-APP1-IFD1", undefined, {
      id: {
        ...occurrenceId("JPEG-APP1-IFD1", 1),
        runtime_tag_id: "282-a",
      },
    });
    const second = occurrence("JPEG-APP1-IFD1", undefined, {
      id: {
        ...occurrenceId("JPEG-APP1-IFD1", 1),
        runtime_tag_id: "282-b",
      },
    });

    const qualifiers = buildOccurrenceDetailsPresentation({
      occurrences: [first, second],
    }).groups[0].rows.map((row) => row.originQualifier);

    expect(qualifiers.every((qualifier) => qualifier !== null)).toBe(true);
    expect(new Set(qualifiers).size).toBe(2);
    expect(qualifiers).toEqual([
      expect.stringContaining("ID-282-a"),
      expect.stringContaining("ID-282-b"),
    ]);
  });

  it("applies duplicate-only qualifiers to New Property and missing rows", () => {
    const missingSource = occurrence("missing", undefined, {
      observed_selector: selector("IFD0"),
      write_target: selector("IFD0"),
    });
    const missing = exactTarget(missingSource);
    const fresh = newTarget(schema, "IFD0", "XResolution");

    const duplicatedRows = buildOccurrenceDetailsPresentation({
      occurrences: [],
      targetDrafts: collection([
        { target: missing, edit: edit() },
        { target: fresh, edit: edit() },
      ]),
      tagInfos: { [schemaDefinitionIdToken(schema)]: tagInfo() },
    }).groups[0].rows;

    expect(duplicatedRows.map((row) => row.kind).sort()).toEqual([
      "MissingOccurrenceDraftRow",
      "NewPropertyRow",
    ]);
    expect(duplicatedRows.every((row) => row.originQualifier !== null)).toBe(
      true,
    );
    expect(new Set(duplicatedRows.map((row) => row.originQualifier)).size).toBe(
      2,
    );

    const soleRows = buildOccurrenceDetailsPresentation({
      occurrences: [],
      targetDrafts: collection([
        { target: missing, edit: edit() },
        { target: newTarget(schema, "IFD1", "XResolution"), edit: edit() },
      ]),
      tagInfos: { [schemaDefinitionIdToken(schema)]: tagInfo() },
    }).groups.flatMap((group) => group.rows);
    expect(soleRows.map((row) => row.originQualifier)).toEqual([null, null]);
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

  it("uses canonical semantic equality for structured list removals and additions", () => {
    const originalItem: MetadataValue = {
      kind: "Struct",
      value: {
        first: { kind: "Text", value: "one" },
        second: { kind: "Integer", value: 2 },
      },
    };
    const reorderedItem: MetadataValue = {
      kind: "Struct",
      value: {
        second: { kind: "Integer", value: 2 },
        first: { kind: "Text", value: "one" },
      },
    };
    const current = occurrence(
      "structured-list",
      {
        kind: "List",
        value: { list_kind: "Bag", items: [originalItem] },
      },
      {
        tag_info: tagInfo(schema, {
          kind: { kind: "Bag", data: { kind: "Struct", data: {} } },
        }),
      },
    );
    const target = exactTarget(current);

    const removed = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        { target, edit: edit(reorderedItem, "ListRemove") },
      ]),
    }).groups[0].rows[0];
    const added = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        { target, edit: edit(reorderedItem, "ListAdd") },
      ]),
    }).groups[0].rows[0];

    expect(removed.kind).toBe("ExistingOccurrenceRow");
    expect(added.kind).toBe("ExistingOccurrenceRow");
    if (
      removed.kind !== "ExistingOccurrenceRow" ||
      added.kind !== "ExistingOccurrenceRow"
    ) {
      throw new Error("wrong row kind");
    }
    expect(removed.effectiveDraftValue).toEqual({
      kind: "List",
      value: { list_kind: "Bag", items: [] },
    });
    expect(removed.stagedValue).toBe("");
    expect(added.effectiveDraftValue).toEqual(current.value);
    expect(added.stagedValue).toBe("first: one; second: 2");
  });

  it("uses canonical semantic equality for rational list removals and additions", () => {
    const half: MetadataValue = {
      kind: "Rational",
      value: { numerator: 1, denominator: 2 },
    };
    const equivalentHalf: MetadataValue = {
      kind: "Rational",
      value: { numerator: 2, denominator: 4 },
    };
    const current = occurrence(
      "rational-list",
      {
        kind: "List",
        value: { list_kind: "Seq", items: [half] },
      },
      {
        tag_info: tagInfo(schema, {
          kind: { kind: "Seq", data: { kind: "Rational" } },
        }),
      },
    );
    const target = exactTarget(current);

    const removed = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        { target, edit: edit(equivalentHalf, "ListRemove") },
      ]),
    }).groups[0].rows[0];
    const added = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        { target, edit: edit(equivalentHalf, "ListAdd") },
      ]),
    }).groups[0].rows[0];

    expect(removed.kind).toBe("ExistingOccurrenceRow");
    expect(added.kind).toBe("ExistingOccurrenceRow");
    if (
      removed.kind !== "ExistingOccurrenceRow" ||
      added.kind !== "ExistingOccurrenceRow"
    ) {
      throw new Error("wrong row kind");
    }
    expect(removed.effectiveDraftValue).toEqual({
      kind: "List",
      value: { list_kind: "Seq", items: [] },
    });
    expect(added.effectiveDraftValue).toEqual(current.value);
  });

  it.each([
    [
      "ListAdd",
      { kind: "Text", value: "staged" },
      { kind: "Text", value: "staged" },
      "staged",
    ],
    ["ListRemove", { kind: "Text", value: "disk" }, null, null],
  ] as const)(
    "previews scalar %s with the backend fallback semantics",
    (intent, staged, expectedValue, expectedDisplay) => {
      const current = occurrence(
        "scalar-list-fallback",
        {
          kind: "Text",
          value: "disk",
        },
        {
          tag_info: tagInfo(schema, { kind: { kind: "Text" } }),
        },
      );
      const target = exactTarget(current);
      const row = buildOccurrenceDetailsPresentation({
        occurrences: [current],
        targetDrafts: collection([{ target, edit: { intent, value: staged } }]),
      }).groups[0].rows[0];

      expect(row.kind).toBe("ExistingOccurrenceRow");
      if (row.kind !== "ExistingOccurrenceRow")
        throw new Error("wrong row kind");
      expect(row.effectiveDraftValue).toEqual(expectedValue);
      expect(row.stagedValue).toBe(expectedDisplay);
    },
  );

  it("distinguishes an unsupported preview from deletion", () => {
    const current = occurrence(
      "unsupported-list-payload",
      { kind: "Text", value: "disk" },
      { tag_info: tagInfo(schema, { kind: { kind: "Text" } }) },
    );
    const target = exactTarget(current);
    const unsupported = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        {
          target,
          edit: {
            intent: "ListAdd",
            value: {
              kind: "List",
              value: {
                list_kind: "Bag",
                items: [{ kind: "Text", value: "new" }],
              },
            },
          },
        },
      ]),
    }).groups[0].rows[0];
    const deleted = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        { target, edit: { intent: "Delete", value: null } },
      ]),
    }).groups[0].rows[0];

    expect(unsupported.kind).toBe("ExistingOccurrenceRow");
    expect(deleted.kind).toBe("ExistingOccurrenceRow");
    if (
      unsupported.kind !== "ExistingOccurrenceRow" ||
      deleted.kind !== "ExistingOccurrenceRow"
    ) {
      throw new Error("wrong row kind");
    }
    expect(unsupported.status.code).toBe("preview-unsupported");
    expect(unsupported.effectiveDraftApplied).toBe(false);
    expect(unsupported.effectiveDraftReason).toBe(
      "A list payload cannot be rendered for a non-list schema.",
    );
    expect(unsupported.searchText).toContain(unsupported.effectiveDraftReason);
    expect(deleted.effectiveDraftApplied).toBe(true);
    expect(deleted.effectiveDraftReason).toBeNull();
  });

  it.each([
    ["South", "S"],
    ["West", "W"],
  ])("preserves the complete Set display label %s", (display, value) => {
    const current = occurrence(
      "labelled-set",
      { kind: "Text", value: "N" },
      {
        tag_info: tagInfo(schema, { kind: { kind: "Text" } }),
      },
    );
    const row = buildOccurrenceDetailsPresentation({
      occurrences: [current],
      targetDrafts: collection([
        {
          target: exactTarget(current),
          edit: { intent: "Set", value: { kind: "Text", value }, display },
        },
      ]),
    }).groups[0].rows[0];

    expect(row.stagedValue).toBe(display);
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

  it("classifies selector occupancy with production case semantics", () => {
    const target = newTarget(otherSchema, "XMP-Custom", "Title");
    const occupied = occurrence("case-collision", undefined, {
      schema_id: structuredClone(otherSchema),
      observed_selector: {
        ...target.write_target,
        group1: "xmp-custom",
        tag_name: "title",
      },
      write_target: null,
    });
    const family7Distinct = occurrence("family7-distinct", undefined, {
      schema_id: structuredClone(otherSchema),
      observed_selector: {
        ...target.write_target,
        group7: target.write_target.group7.toLowerCase(),
      },
      write_target: null,
    });
    const entry = { target, edit: edit({ kind: "Text", value: "New" }) };

    const occupiedRow = buildOccurrenceDetailsPresentation({
      occurrences: [occupied],
      targetDrafts: collection([entry]),
    })
      .groups.flatMap((group) => group.rows)
      .find((row) => row.kind === "NewPropertyRow");
    const distinctRow = buildOccurrenceDetailsPresentation({
      occurrences: [family7Distinct],
      targetDrafts: collection([entry]),
    })
      .groups.flatMap((group) => group.rows)
      .find((row) => row.kind === "NewPropertyRow");

    expect(occupiedRow?.status.code).toBe("destination-occupied");
    expect(distinctRow?.status.code).toBe("new");
  });

  it.each([
    ["missing", [], "xmp-custom", "ID-Title", "title", true],
    [
      "stale",
      [
        occurrence("missing-owner", undefined, {
          observed_selector: selector("IFD0"),
          write_target: selector("IFD0"),
        }),
      ],
      "XMP-Custom",
      "ID-Title",
      "Title",
      true,
    ],
    ["family-7 case difference", [], "XMP-Custom", "id-title", "Title", false],
  ] as const)(
    "classifies a %s ExistingOccurrence pending selector without changing the New Property owner",
    (_case, occurrences, group1, group7, tagName, collides) => {
      const target = newTarget(otherSchema, "XMP-Custom", "Title");
      const conflictingOwner = occurrence("missing-owner");
      const conflictingTarget = {
        ...exactTarget(conflictingOwner),
        write_target: { group1, group7, tag_name: tagName },
      };
      const targetDrafts = collection([
        { target, edit: edit({ kind: "Text", value: "New" }) },
        { target: conflictingTarget, edit: edit() },
      ]);

      const row = buildOccurrenceDetailsPresentation({
        occurrences,
        targetDrafts,
      })
        .groups.flatMap((group) => group.rows)
        .find((candidate) => candidate.kind === "NewPropertyRow");
      const production = classifyNewPropertyDestination({
        schemaId: target.schema_id,
        writeTarget: target.write_target,
        occurrences,
        pendingTargets: Object.values(targetDrafts).map(
          (entry) => entry.target,
        ),
        ignoredPendingTarget: target,
      });

      expect(row?.kind).toBe("NewPropertyRow");
      expect(row?.target).toEqual(target);
      expect(row?.removalTarget).toEqual(target);
      expect(row?.destinationSafety).toEqual(production);
      if (collides) {
        expect(row?.status.code).toBe("pending-target-conflict");
        expect(row?.status.label).toBe("Destination used by pending edit");
        expect(row?.searchText).toContain("Destination used by pending edit");
        expect(row?.searchText).toContain(JSON.stringify(conflictingTarget));
      } else {
        expect(row?.status.code).toBe("new");
      }
    },
  );

  it("keeps an unknown same-schema New Property exact and visibly unsafe", () => {
    const target = newTarget(otherSchema, "XMP-custom", "Title");
    const unknown = occurrence("unknown-selector", undefined, {
      schema_id: structuredClone(otherSchema),
      observed_selector: null,
      write_target: null,
    });

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [unknown],
      targetDrafts: collection([
        { target, edit: edit({ kind: "Text", value: "New" }) },
      ]),
    })
      .groups.flatMap((group) => group.rows)
      .find((candidate) => candidate.kind === "NewPropertyRow");

    expect(row?.kind).toBe("NewPropertyRow");
    expect(row?.status.code).toBe("destination-unknown");
    expect(row?.status.label).toBe("Destination cannot be verified");
    expect(row?.searchText).toContain("Destination cannot be verified");
    expect(row?.removalTarget).toEqual(target);
    expect(row?.target).toEqual(target);
    expect(row?.intendedDestination).toEqual(target.write_target);
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

  it("treats an exact current write destination as occupied even when its observed selector differs", () => {
    const target = newTarget(otherSchema, "WritableDestination", "Title");
    const occupied = occurrence(
      "occupied-via-write-target",
      { kind: "Text", value: "Current" },
      {
        schema_id: structuredClone(otherSchema),
        tag_info: tagInfo(otherSchema, { kind: { kind: "Text" } }),
        observed_selector: {
          group1: "ObservedElsewhere",
          group7: target.write_target.group7,
          tag_name: target.write_target.tag_name,
        },
        write_target: structuredClone(target.write_target),
      },
    );

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [occupied],
      targetDrafts: collection([
        { target, edit: edit({ kind: "Text", value: "New" }) },
      ]),
    })
      .groups.flatMap((group) => group.rows)
      .find((candidate) => candidate.kind === "NewPropertyRow");

    expect(row?.status.code).toBe("destination-occupied");
  });

  it("uses resolved TagInfo for a missing-target warning row's friendly label", () => {
    const missingOccurrence = occurrence("missing-friendly", undefined, {
      schema_id: structuredClone(otherSchema),
      tag_info: tagInfo(otherSchema, {
        name: "Friendly title",
        kind: { kind: "Text" },
      }),
      observed_selector: {
        group1: "XMP-custom",
        group7: "ID-Title",
        tag_name: "RuntimeTitle",
      },
      write_target: {
        group1: "XMP-custom",
        group7: "ID-Title",
        tag_name: "RuntimeTitle",
      },
    });
    const target = exactTarget(missingOccurrence);
    const info = tagInfo(otherSchema, {
      name: "Friendly title",
      kind: { kind: "Text" },
    });

    const row = buildOccurrenceDetailsPresentation({
      occurrences: [],
      targetDrafts: collection([
        { target, edit: edit({ kind: "Text", value: "staged" }) },
      ]),
      tagInfos: { [schemaDefinitionIdToken(otherSchema)]: info },
    }).groups[0].rows[0];

    expect(row.kind).toBe("MissingOccurrenceDraftRow");
    expect(row.label).toBe("Friendly title");
    expect(row.searchText).toContain("Friendly title");
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

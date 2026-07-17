// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ImageMetadataOccurrencesStore } from "../types";
import type {
  MetadataDraftEdit,
  MetadataDraftTarget,
  SchemaDefinitionId,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import { computeEffectiveMetadataKeyFrequency } from "../utils/metadataKeyFrequency";
import { metadataCollection } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import { makePhotos, testId } from "./factories";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
const title = testId("XMP-dc:Title");
const model = testId("IFD0:Model");
const setDraft = (value: string): MetadataDraftEdit => ({
  intent: "Set",
  value: { kind: "Text", value },
});
const deleteDraft = (): MetadataDraftEdit => ({
  intent: "Delete",
  value: null,
});

function committed(...entries: Array<[SchemaDefinitionId, string]>) {
  return metadataCollection(
    entries.map(([id, value]) => ({
      id,
      value: { kind: "Text" as const, value },
    })),
  );
}

function newProperty(id: SchemaDefinitionId): MetadataDraftTarget {
  return { kind: "NewProperty", schema_id: id };
}

function existing(
  id: SchemaDefinitionId,
  path: string,
  copy = 0,
): MetadataDraftTarget {
  return {
    kind: "ExistingOccurrence",
    occurrence_id: {
      document: null,
      path,
      runtime_tag_id: id.tag_id,
      tag_id_scope: {
        table: id.table,
        tag_id: id.tag_id,
        index: id.index ?? null,
      },
      copy,
    },
    schema_id: id,
    write_target: { group1: "Test", tag_name: id.tag_id },
  };
}

function setup(paths: string[]) {
  const metadata = new ImageMetadataOccurrencesStore();
  for (const path of paths) metadata.add(path);
  const drafts = new TargetDraftEditsStore();
  return { metadata, drafts };
}

function counts(
  paths: string[],
  metadata: ImageMetadataOccurrencesStore,
  drafts: TargetDraftEditsStore,
) {
  return new Map(
    computeEffectiveMetadataKeyFrequency(
      makePhotos(paths),
      metadata,
      drafts.getAllMetadata(),
    ).map(({ id, count }) => [schemaDefinitionIdToken(id), count]),
  );
}

describe("computeEffectiveMetadataKeyFrequency", () => {
  it("counts committed keys across files", () => {
    const { metadata, drafts } = setup(["a.jpg", "b.jpg"]);
    metadata.set(
      "a.jpg",
      occurrencesFromMetadataCollection(committed([model, "Canon"])),
    );
    metadata.set(
      "b.jpg",
      occurrencesFromMetadataCollection(
        committed([model, "Nikon"], [title, "Two"]),
      ),
    );

    const result = counts(["a.jpg", "b.jpg"], metadata, drafts);
    expect(result.get(schemaDefinitionIdToken(model))).toBe(2);
    expect(result.get(schemaDefinitionIdToken(title))).toBe(1);
  });

  it("counts draft-only NewProperty keys", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set("a.jpg", occurrencesFromMetadataCollection(committed()));
    drafts.setMetadataTarget("a.jpg", newProperty(title), setDraft("Draft"));

    expect(
      counts(["a.jpg"], metadata, drafts).get(schemaDefinitionIdToken(title)),
    ).toBe(1);
  });

  it("counts exact ExistingOccurrence draft keys", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set("a.jpg", occurrencesFromMetadataCollection(committed()));
    drafts.setMetadataTarget(
      "a.jpg",
      existing(title, "JPEG-APP1-XMP"),
      setDraft("Draft"),
    );

    expect(
      counts(["a.jpg"], metadata, drafts).get(schemaDefinitionIdToken(title)),
    ).toBe(1);
  });

  it("counts committed and drafted copies once per file", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set(
      "a.jpg",
      occurrencesFromMetadataCollection(committed([title, "Committed"])),
    );
    drafts.setMetadataTarget(
      "a.jpg",
      existing(title, "JPEG-APP1-XMP"),
      setDraft("Draft"),
    );

    expect(
      counts(["a.jpg"], metadata, drafts).get(schemaDefinitionIdToken(title)),
    ).toBe(1);
  });

  it("counts the same schema across different files", () => {
    const { metadata, drafts } = setup(["a.jpg", "b.jpg"]);
    metadata.set(
      "a.jpg",
      occurrencesFromMetadataCollection(committed([title, "Committed"])),
    );
    metadata.set("b.jpg", occurrencesFromMetadataCollection(committed()));
    drafts.setMetadataTarget("b.jpg", newProperty(title), setDraft("Draft"));

    expect(
      counts(["a.jpg", "b.jpg"], metadata, drafts).get(
        schemaDefinitionIdToken(title),
      ),
    ).toBe(2);
  });

  it("counts multiple exact same-schema targets once for one file", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set("a.jpg", occurrencesFromMetadataCollection(committed()));
    drafts.setMetadataTarget(
      "a.jpg",
      existing(title, "JPEG-APP1-IFD0", 0),
      setDraft("IFD0"),
    );
    drafts.setMetadataTarget(
      "a.jpg",
      existing(title, "JPEG-APP1-IFD1", 1),
      setDraft("IFD1"),
    );

    expect(Object.keys(drafts.getMetadataFile("a.jpg") ?? {})).toHaveLength(2);
    expect(
      counts(["a.jpg"], metadata, drafts).get(schemaDefinitionIdToken(title)),
    ).toBe(1);
  });
  it("omits a schema after a safe unique ExistingOccurrence Delete", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set("a.jpg", occurrencesFromMetadataCollection(committed()));
    drafts.setMetadataTarget(
      "a.jpg",
      existing(title, "JPEG-APP1-XMP"),
      deleteDraft(),
    );

    expect(
      counts(["a.jpg"], metadata, drafts).get(schemaDefinitionIdToken(title)),
    ).toBeUndefined();
  });

  it("counts drafts while committed metadata is loading", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    drafts.setMetadataTarget("a.jpg", newProperty(title), setDraft("Draft"));

    expect(
      counts(["a.jpg"], metadata, drafts).get(schemaDefinitionIdToken(title)),
    ).toBe(1);
  });

  it("ignores stale drafts outside the current photo list", () => {
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set("a.jpg", occurrencesFromMetadataCollection(committed()));
    drafts.setMetadataTarget(
      "stale.jpg",
      newProperty(title),
      setDraft("Stale"),
    );

    expect(
      counts(["a.jpg"], metadata, drafts).has(schemaDefinitionIdToken(title)),
    ).toBe(false);
  });

  it("reflects metadata updates after apply", () => {
    const { metadata, drafts } = setup(["a.jpg", "b.jpg"]);
    metadata.set(
      "a.jpg",
      occurrencesFromMetadataCollection(committed([title, "One"])),
    );
    metadata.set("b.jpg", occurrencesFromMetadataCollection(committed()));
    metadata.set(
      "b.jpg",
      occurrencesFromMetadataCollection(committed([title, "Two"])),
    );

    expect(
      counts(["a.jpg", "b.jpg"], metadata, drafts).get(
        schemaDefinitionIdToken(title),
      ),
    ).toBe(2);
  });

  it("keeps an absent schema index distinct from index zero", () => {
    const zero = { ...title, index: 0 };
    const { metadata, drafts } = setup(["a.jpg"]);
    metadata.set(
      "a.jpg",
      occurrencesFromMetadataCollection(committed([title, "Absent index"])),
    );
    drafts.setMetadataTarget("a.jpg", newProperty(zero), setDraft("Zero"));

    const result = counts(["a.jpg"], metadata, drafts);
    expect(result.get(schemaDefinitionIdToken(title))).toBe(1);
    expect(result.get(schemaDefinitionIdToken(zero))).toBe(1);
    expect(result.size).toBe(2);
  });
});

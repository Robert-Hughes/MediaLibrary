import { describe, expect, it } from "vitest";
import { SearchIndex } from "../search/searchIndex";
import type {
  MetadataDraftEdit,
  MetadataOccurrence,
  SchemaDefinitionId,
} from "../types";
import type {
  SearchOccurrenceEntry,
  SearchSchemaLabel,
} from "../workers/searchWorkerProtocol";

const edit = (value: string): MetadataDraftEdit => ({
  value: { kind: "Text", value },
  intent: "Set",
});
const del: MetadataDraftEdit = { value: null, intent: "Delete" };

function occurrence(
  schemaId: SchemaDefinitionId,
  value: string,
  options: {
    path?: string;
    copy?: number;
    document?: string | null;
    runtimeTagId?: string;
  } = {},
): MetadataOccurrence {
  return {
    id: {
      document: options.document ?? null,
      path: options.path ?? "JPEG-APP1-XMP",
      runtime_tag_id: options.runtimeTagId ?? schemaId.tag_id,
      tag_id_scope: {
        table: "TestFixture::Runtime",
        tag_id: options.runtimeTagId ?? schemaId.tag_id,
        index: null,
      },
      copy: options.copy ?? 0,
    },
    schema_id: structuredClone(schemaId),
    value: { kind: "Text", value },
    tag_info: null,
    write_target: null,
  };
}

function searchable(...items: MetadataOccurrence[]): SearchOccurrenceEntry[] {
  return items.map((item) => ({
    schemaId: structuredClone(item.schema_id),
    value: structuredClone(item.value),
    occurrenceId: structuredClone(item.id),
  }));
}

const drafts = (entries: Record<string, MetadataDraftEdit>) =>
  Object.entries(entries).map(([key, draftEdit]) => ({
    id: { table: key, tag_id: key },
    edit: draftEdit,
  }));

function seed(idx: SearchIndex) {
  for (const path of ["a.jpg", "b.jpg", "sub/c.jpg"]) {
    idx.setPhoto({
      relative_path: path,
      filename: path.split("/").slice(-1)[0]!,
      date_modified: 1_700_000_000,
      date_created: null,
    });
  }
}

function matchedSet(idx: SearchIndex, query: string): Set<string> {
  return new Set(idx.query(query).matched);
}

describe("SearchIndex", () => {
  it("searches filenames, paths and every occurrence value", () => {
    const idx = new SearchIndex();
    seed(idx);
    const schema = { table: "Exif::Main", tag_id: "282" };
    idx.setOccurrences(
      "a.jpg",
      searchable(
        occurrence(schema, "300", { path: "JPEG-APP1-IFD0", copy: 0 }),
        occurrence(schema, "72", { path: "JPEG-APP1-IFD1", copy: 1 }),
      ),
    );

    expect(matchedSet(idx, "sub/")).toEqual(new Set(["sub/c.jpg"]));
    expect(matchedSet(idx, "300")).toEqual(new Set(["a.jpg"]));
    expect(matchedSet(idx, "72")).toEqual(new Set(["a.jpg"]));
  });

  it("indexes unknown schemas and exact occurrence diagnostics", () => {
    const idx = new SearchIndex();
    seed(idx);
    const unknown = {
      table: "MakerNotes::Unknown",
      tag_id: "0xBEEF",
      index: 0,
    };
    idx.setOccurrences(
      "a.jpg",
      searchable(
        occurrence(unknown, "mystery", {
          document: "doc-2",
          path: "JPEG-APP1-MakerNotes",
          runtimeTagId: "48879",
          copy: 3,
        }),
      ),
    );

    for (const query of [
      "MakerNotes::Unknown",
      "0xBEEF",
      "index 0",
      "mystery",
      "doc-2",
      "JPEG-APP1-MakerNotes",
      "tag:48879",
      "copy:3",
    ]) {
      expect(matchedSet(idx, query), query).toEqual(new Set(["a.jpg"]));
    }
  });

  it("uses exact-ID labels as search text without using them as identity", () => {
    const idx = new SearchIndex();
    seed(idx);
    const id = { table: "XMP::dc", tag_id: "0x1234" };
    const label: SearchSchemaLabel = {
      id,
      group: "XMP-dc",
      name: "Title",
      description: "A short title for the resource",
    };
    idx.setOccurrences("a.jpg", searchable(occurrence(id, "Northern lights")), [
      label,
    ]);

    for (const query of [
      "XMP-dc:Title",
      "short title for the resource",
      "XMP::dc",
      "0x1234",
      "Northern lights",
    ]) {
      expect(matchedSet(idx, query), query).toEqual(new Set(["a.jpg"]));
    }
  });

  it("keeps omitted schema index distinct from index zero", () => {
    const idx = new SearchIndex();
    seed(idx);
    idx.setOccurrences(
      "a.jpg",
      searchable(occurrence({ table: "T", tag_id: "7" }, "none-index")),
    );
    idx.setOccurrences(
      "b.jpg",
      searchable(
        occurrence({ table: "T", tag_id: "7", index: 0 }, "zero-index"),
      ),
    );
    expect(matchedSet(idx, "index 0")).toEqual(new Set(["b.jpg"]));
    expect(matchedSet(idx, "none-index")).toEqual(new Set(["a.jpg"]));
  });

  it("treats loading as no occurrence text and invalidates cached queries on upsert", () => {
    const idx = new SearchIndex();
    seed(idx);
    idx.setOccurrences("a.jpg", "loading");
    expect(matchedSet(idx, "uniquemeta")).toEqual(new Set());
    idx.setOccurrences(
      "a.jpg",
      searchable(occurrence({ table: "X", tag_id: "Y" }, "uniquemeta")),
    );
    expect(matchedSet(idx, "uniquemeta")).toEqual(new Set(["a.jpg"]));
  });

  it("indexes drafts and preserves has:edits semantics", () => {
    const idx = new SearchIndex();
    seed(idx);
    idx.setDrafts("a.jpg", drafts({ "X:Y": edit("a tasty muffin") }));
    idx.setDrafts("b.jpg", drafts({ "X:Y": del }));
    expect(matchedSet(idx, "muffin")).toEqual(new Set(["a.jpg"]));
    expect(matchedSet(idx, "has:edits")).toEqual(new Set(["a.jpg", "b.jpg"]));
    expect(matchedSet(idx, "has:edits a.jpg")).toEqual(new Set(["a.jpg"]));
    idx.setDrafts("a.jpg", undefined);
    expect(matchedSet(idx, "muffin")).toEqual(new Set());
  });

  it("handles deletion, clear and photo upserts", () => {
    const idx = new SearchIndex();
    seed(idx);
    idx.deletePath("a.jpg");
    expect(matchedSet(idx, "a.jpg")).toEqual(new Set());
    idx.setPhoto({
      relative_path: "b.jpg",
      filename: "renamed.jpg",
      date_modified: null,
      date_created: null,
    });
    expect(matchedSet(idx, "renamed")).toEqual(new Set(["b.jpg"]));
    idx.clear();
    expect(idx.size()).toBe(0);
    expect(matchedSet(idx, "")).toEqual(new Set());
  });
});

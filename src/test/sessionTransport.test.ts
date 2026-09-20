import { describe, expect, it } from "vitest";
import {
  decodeMetadataDictionaryDelta,
  METADATA_DICTIONARY_FORMAT,
} from "../sessionTransport";
import { FileMetadataOccurrencesStore, MetadataProgressStore } from "../types";
import { projectSessionMetadata } from "../sessionMetadataProjection";

function metadataWire() {
  const sharedSchema = {
    table: "XMP::dc",
    tag_id: "description",
  };
  const unknownSchema = {
    table: "Unknown::Table",
    tag_id: "unknown",
  };
  const sharedObserved = {
    group1: "XMP-dc",
    group7: "ID-description",
    tag_name: "Description",
  };
  const sharedWriteTarget = {
    group1: "XMP-dc",
    group7: "ID-description",
    tag_name: "Description",
  };

  return {
    format: METADATA_DICTIONARY_FORMAT,
    session_id: 7,
    revision: 12,
    dictionaries: {
      ids: [
        {
          document: null,
          path: "XMP-a",
          runtime_tag_id: "description-a",
          tag_id_scope: {
            table: "XMP::dc",
            tag_id: "description-a",
            index: null,
          },
          copy: 0,
        },
        {
          document: null,
          path: "XMP-b",
          runtime_tag_id: "description-b",
          tag_id_scope: {
            table: "XMP::dc",
            tag_id: "description-b",
            index: null,
          },
          copy: 1,
        },
        {
          document: null,
          path: "UNKNOWN",
          runtime_tag_id: "unknown",
          tag_id_scope: {
            table: "Unknown::Table",
            tag_id: "unknown",
            index: null,
          },
          copy: 0,
        },
      ],
      schema_ids: [sharedSchema, unknownSchema],
      values: [
        { kind: "Text", value: "same" },
        { kind: "Text", value: "other" },
      ],
      observed_selectors: [sharedObserved, null],
      write_targets: [sharedWriteTarget, null],
    },
    entries: [
      {
        relative_path: "shared.jpg",
        state: {
          status: "ready",
          occurrences: [
            [0, 0, 0, 0, 0],
            [1, 0, 0, 0, 0],
          ],
        },
      },
      {
        relative_path: "nulls.jpg",
        state: {
          status: "ready",
          occurrences: [[2, 1, 1, 1, 1]],
        },
      },
    ],
  };
}

describe("session metadata dictionary transport", () => {
  it("reconstructs exact occurrences while sharing dictionary entries", () => {
    const decoded = decodeMetadataDictionaryDelta(metadataWire());
    expect(decoded.session_id).toBe(7);
    expect(decoded.revision).toBe(12);

    const shared = decoded.entries[0]!;
    if (shared.state.status !== "ready")
      throw new Error("expected ready state");

    expect(shared.state.occurrences).toHaveLength(2);
    const first = shared.state.occurrences[0]!;
    const second = shared.state.occurrences[1]!;
    expect(first.id).not.toEqual(second.id);
    expect(first.id.path).toBe("XMP-a");
    expect(second.id.path).toBe("XMP-b");
    expect(first.schema_id).toBe(second.schema_id);
    expect(first.value).toBe(second.value);
    expect(first.observed_selector).toBe(second.observed_selector);
    expect(first.write_target).toBe(second.write_target);

    const nulls = decoded.entries[1]!;
    if (nulls.state.status !== "ready") throw new Error("expected ready state");
    expect(nulls.state.occurrences[0]).toMatchObject({
      observed_selector: null,
      write_target: null,
    });
  });

  it("preserves equal values without merging distinct exact identities", () => {
    const decoded = decodeMetadataDictionaryDelta(metadataWire());
    const state = decoded.entries[0]!.state;
    if (state.status !== "ready") throw new Error("expected ready state");

    expect(state.occurrences[0]!.value).toEqual(state.occurrences[1]!.value);
    expect(state.occurrences[0]!.id).not.toEqual(state.occurrences[1]!.id);
    expect(state.occurrences).toHaveLength(2);
  });

  it("projects decoded ready files through the existing progress model", () => {
    const decoded = decodeMetadataDictionaryDelta(metadataWire());
    const occurrences = new FileMetadataOccurrencesStore();
    const progress = new MetadataProgressStore();
    progress.setTotal(2);

    projectSessionMetadata(decoded.entries, false, { occurrences, progress });

    expect(progress.getRemaining()).toBe(0);
    expect(occurrences.get("shared.jpg")).not.toBe("loading");
    expect(occurrences.get("nulls.jpg")).not.toBe("loading");
  });

  it("rejects mismatched versions and invalid indexes explicitly", () => {
    const wire = metadataWire();
    expect(() =>
      decodeMetadataDictionaryDelta({ ...wire, format: "future-format" }),
    ).toThrow(/Unsupported metadata dictionary format/);

    wire.entries[0]!.state.occurrences[0]![0] = 99;
    expect(() => decodeMetadataDictionaryDelta(wire)).toThrow(
      /Invalid id dictionary index 99/,
    );
  });
});

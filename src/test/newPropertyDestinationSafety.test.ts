import { describe, expect, it } from "vitest";
import type {
  MetadataDraftTarget,
  MetadataOccurrence,
  MetadataWriteTarget,
  SchemaDefinitionId,
} from "../types";
import { classifyNewPropertyDestination } from "../utils/newPropertyDestinationSafety";

const schemaId: SchemaDefinitionId = {
  table: "XMP::test",
  tag_id: "Field",
};
const destination: MetadataWriteTarget = {
  group1: "XMP-Custom",
  group7: "ID-Field",
  tag_name: "Field",
};

function occurrence(
  observedSelector: MetadataWriteTarget | null,
): MetadataOccurrence {
  return {
    id: {
      document: null,
      path: "XMP-test",
      runtime_tag_id: "Field",
      tag_id_scope: { table: "XMP::test", tag_id: "Field", index: null },
      copy: 0,
    },
    schema_id: schemaId,
    value: { kind: "Text", value: "current" },
    tag_info: null,
    observed_selector: observedSelector,
    write_target: null,
  };
}

function classify(observedSelector: MetadataWriteTarget | null) {
  return classifyNewPropertyDestination({
    schemaId,
    writeTarget: destination,
    occurrences: [occurrence(observedSelector)],
  });
}

describe("classifyNewPropertyDestination", () => {
  it("treats a family-1 case-only difference as occupied", () => {
    expect(
      classify({ ...destination, group1: destination.group1.toLowerCase() })
        .kind,
    ).toBe("occupied");
  });

  it("treats a tag-name case-only difference as occupied", () => {
    expect(
      classify({ ...destination, tag_name: destination.tag_name.toLowerCase() })
        .kind,
    ).toBe("occupied");
  });

  it("keeps family-7 case differences distinct", () => {
    expect(
      classify({ ...destination, group7: destination.group7.toLowerCase() })
        .kind,
    ).toBe("available");
  });

  it("reports an unavailable selector on the same exact schema as unknown", () => {
    expect(classify(null).kind).toBe("unknown-same-schema");
  });

  it("reports a sibling selector collision without substituting its target", () => {
    const sibling: MetadataDraftTarget = {
      kind: "NewProperty",
      schema_id: { table: "Other::Table", tag_id: "Other" },
      write_target: { ...destination, group1: "xmp-custom" },
    };
    const result = classifyNewPropertyDestination({
      schemaId,
      writeTarget: destination,
      occurrences: [],
      pendingTargets: [sibling],
    });

    expect(result).toEqual({ kind: "pending-collision", target: sibling });
  });
});

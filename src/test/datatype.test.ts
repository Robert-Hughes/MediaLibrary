import { describe, it, expect } from "vitest";
import {
  metadataValueDatatype,
  schemaDatatype,
  variantDatatype,
  datatypesMatch,
} from "../utils/datatype";
import type { TagKind } from "../types";

describe("schemaDatatype", () => {
  it("maps scalar kinds", () => {
    expect(schemaDatatype({ kind: "Text" })?.code).toBe("S");
    expect(schemaDatatype({ kind: "LangAlt" })?.code).toBe("LA");
    expect(
      schemaDatatype({ kind: "Integer", data: { min: null, max: null } })?.code,
    ).toBe("I");
    expect(schemaDatatype({ kind: "Real" })?.code).toBe("R");
    expect(schemaDatatype({ kind: "Rational" })?.code).toBe("Q");
    expect(schemaDatatype({ kind: "Boolean" })?.code).toBe("B");
    expect(schemaDatatype({ kind: "Date" })?.code).toBe("D");
    expect(schemaDatatype({ kind: "Time" })?.code).toBe("T");
    expect(schemaDatatype({ kind: "DateTime" })?.code).toBe("DT");
    expect(schemaDatatype({ kind: "Binary" })?.code).toBe("Bin");
  });

  it("treats Unknown kind as no schema (returns null)", () => {
    expect(schemaDatatype({ kind: "Unknown" })).toBeNull();
  });

  it("maps container kinds distinctly", () => {
    const t: TagKind = { kind: "Text" };
    expect(schemaDatatype({ kind: "Bag", data: t })?.code).toBe("[B]");
    expect(schemaDatatype({ kind: "Seq", data: t })?.code).toBe("[S]");
    expect(schemaDatatype({ kind: "Alt", data: t })?.code).toBe("[A]");
    expect(schemaDatatype({ kind: "Struct", data: {} })?.code).toBe("{}");
  });

  it("returns null when kind is missing", () => {
    expect(schemaDatatype(null)).toBeNull();
    expect(schemaDatatype(undefined)).toBeNull();
  });
});

describe("variantDatatype", () => {
  it("classifies primitive variants", () => {
    expect(variantDatatype("hello")?.code).toBe("S");
    expect(variantDatatype(42)?.code).toBe("N");
    expect(variantDatatype(3.14)?.code).toBe("N");
    expect(variantDatatype(true)?.code).toBe("B");
    expect(variantDatatype(null)?.code).toBe("∅");
  });

  it("classifies containers", () => {
    expect(variantDatatype(["a"])?.code).toBe("L");
    expect(variantDatatype({ x: "y" })?.code).toBe("{}");
  });

  it("returns null for undefined", () => {
    expect(variantDatatype(undefined)).toBeNull();
  });
});

describe("metadataValueDatatype", () => {
  it("classifies semantic scalar values distinctly", () => {
    expect(metadataValueDatatype({ kind: "Integer", value: 5 })?.code).toBe(
      "I",
    );
    expect(metadataValueDatatype({ kind: "Real", value: 5 })?.code).toBe("R");
    expect(
      metadataValueDatatype({
        kind: "Rational",
        value: { numerator: 1, denominator: 250 },
      })?.code,
    ).toBe("Q");
  });

  it("classifies semantic list kinds distinctly", () => {
    expect(
      metadataValueDatatype({
        kind: "List",
        value: { list_kind: "Bag", items: [] },
      })?.code,
    ).toBe("[B]");
    expect(
      metadataValueDatatype({
        kind: "List",
        value: { list_kind: "Seq", items: [] },
      })?.code,
    ).toBe("[S]");
    expect(
      metadataValueDatatype({
        kind: "List",
        value: { list_kind: "Alt", items: [] },
      })?.code,
    ).toBe("[A]");
  });

  it("marks binary and unknown values as non-ordinary values", () => {
    expect(metadataValueDatatype({ kind: "Binary" })?.code).toBe("Bin");
    expect(
      metadataValueDatatype({
        kind: "Unknown",
        value: { expected: null, raw: "bad", reason: "no schema" },
      })?.code,
    ).toBe("?");
  });
});

describe("datatypesMatch", () => {
  it("matches identical codes", () => {
    expect(datatypesMatch("S", "S")).toBe(true);
    expect(datatypesMatch("B", "B")).toBe(true);
  });

  it("treats number as compatible with Integer and Real but not Rational", () => {
    expect(datatypesMatch("N", "I")).toBe(true);
    expect(datatypesMatch("N", "R")).toBe(true);
    expect(datatypesMatch("N", "Q")).toBe(false);
  });

  it("treats string as compatible with string-encoded schemas", () => {
    expect(datatypesMatch("S", "LA")).toBe(true);
    expect(datatypesMatch("S", "D")).toBe(true);
    expect(datatypesMatch("S", "T")).toBe(true);
    expect(datatypesMatch("S", "DT")).toBe(true);
    expect(datatypesMatch("S", "E")).toBe(true);
    expect(datatypesMatch("S", "Q")).toBe(true);
    expect(datatypesMatch("S", "I")).toBe(false);
  });

  it("treats list as compatible with Bag/Seq/Alt", () => {
    expect(datatypesMatch("L", "[B]")).toBe(true);
    expect(datatypesMatch("L", "[S]")).toBe(true);
    expect(datatypesMatch("L", "[A]")).toBe(true);
    expect(datatypesMatch("L", "S")).toBe(false);
  });

  it("rejects unrelated codes", () => {
    expect(datatypesMatch("N", "S")).toBe(false);
    expect(datatypesMatch("S", "N")).toBe(false);
    expect(datatypesMatch("∅", "S")).toBe(false);
  });
});

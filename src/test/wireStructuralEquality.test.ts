// @vitest-environment node
import { describe, expect, it } from "vitest";
import { wireStructuralEqual } from "../utils/wireStructuralEquality";

describe("wireStructuralEqual", () => {
  it("ignores property order and compares nested structures", () => {
    expect(
      wireStructuralEqual(
        { a: 1, nested: { x: [true, { y: "z" }] } },
        { nested: { x: [true, { y: "z" }] }, a: 1 },
      ),
    ).toBe(true);
  });

  it("keeps array order and exact rational representation significant", () => {
    expect(wireStructuralEqual([1, 2], [2, 1])).toBe(false);
    expect(
      wireStructuralEqual(
        { kind: "Rational", value: { numerator: 1, denominator: 2 } },
        { kind: "Rational", value: { numerator: 2, denominator: 4 } },
      ),
    ).toBe(false);
  });

  it("treats an optional undefined field as absent but not as a value", () => {
    expect(
      wireStructuralEqual(
        { intent: "Set" },
        { intent: "Set", optional: undefined },
      ),
    ).toBe(true);
    expect(
      wireStructuralEqual(
        { intent: "Set" },
        { intent: "Set", optional: "value" },
      ),
    ).toBe(false);
  });

  it("handles reserved own keys without consulting prototypes", () => {
    const left = Object.fromEntries([["__proto__", { value: 1 }]]);
    const right = Object.fromEntries([["__proto__", { value: 1 }]]);
    const inherited = Object.create({ inherited: 1 }) as Record<
      string,
      unknown
    >;
    inherited.own = "value";
    expect(wireStructuralEqual(left, right)).toBe(true);
    expect(wireStructuralEqual(inherited, { own: "value" })).toBe(true);
  });

  it("rejects cycles safely", () => {
    const left: { self?: unknown } = {};
    const right: { self?: unknown } = {};
    left.self = left;
    right.self = right;
    expect(wireStructuralEqual(left, right)).toBe(false);
  });

  it("does not mutate either input", () => {
    const left = { nested: { b: 2, a: 1 } };
    const right = { nested: { a: 1, b: 2 } };
    const leftBefore = structuredClone(left);
    const rightBefore = structuredClone(right);
    expect(wireStructuralEqual(left, right)).toBe(true);
    expect(left).toEqual(leftBefore);
    expect(right).toEqual(rightBefore);
  });
});

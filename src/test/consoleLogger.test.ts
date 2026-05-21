/**
 * Unit tests for the printf-style argument substitution used when
 * forwarding intercepted `console.*` calls to the Rust log target.
 *
 * React occasionally emits messages like `"Warning: %s\n%s"` and we
 * need those rendered correctly in the on-disk log; tests pin the
 * subset of the browser console contract we implement (%s/%d/%i/%f/
 * %o/%O/%c/%%).
 */
import { describe, it, expect } from "vitest";
import { formatArgs } from "../consoleLogger";

describe("consoleLogger.formatArgs", () => {
  it("returns empty string when no args", () => {
    expect(formatArgs([])).toBe("");
  });

  it("returns the single arg's stringified form when not a format string", () => {
    expect(formatArgs([42])).toBe("42");
    expect(formatArgs([{ a: 1 }])).toBe('{"a":1}');
    expect(formatArgs([null])).toBe("null");
    expect(formatArgs([undefined])).toBe("undefined");
  });

  it("joins non-format-string args with spaces", () => {
    expect(formatArgs([1, 2, "three"])).toBe("1 2 three");
  });

  it("substitutes %s with stringified value", () => {
    expect(formatArgs(["hello %s", "world"])).toBe("hello world");
  });

  it("substitutes %d and %i as integers", () => {
    expect(formatArgs(["count=%d", 42.7])).toBe("count=42");
    expect(formatArgs(["count=%i", "17"])).toBe("count=17");
  });

  it("substitutes %f as float", () => {
    expect(formatArgs(["pi=%f", 3.14])).toBe("pi=3.14");
  });

  it("substitutes %o and %O as stringified", () => {
    expect(formatArgs(["obj=%o", { x: 1 }])).toBe('obj={"x":1}');
    expect(formatArgs(["obj=%O", { y: 2 }])).toBe('obj={"y":2}');
  });

  it("consumes %c (CSS) without rendering, advancing arg pointer", () => {
    expect(formatArgs(["%cstyled %s", "color:red", "tail"]))
      .toBe("styled tail");
  });

  it("renders %% as a literal percent", () => {
    expect(formatArgs(["100%% done"])).toBe("100% done");
  });

  it("handles multiple specifiers in order", () => {
    expect(formatArgs(["%s=%d (%s)", "answer", 42, "to life"]))
      .toBe("answer=42 (to life)");
  });

  it("appends extra args beyond the format string with a separator", () => {
    expect(formatArgs(["msg=%s", "hello", "extra1", "extra2"]))
      .toBe("msg=hello extra1 extra2");
  });

  it("leaves a specifier intact when there is no matching arg", () => {
    expect(formatArgs(["a=%s b=%s", "one"])).toBe("a=one b=%s");
  });

  it("renders the React-warning shape correctly", () => {
    // The motivating use case: React emits "Warning: %s\n%s" — both
    // %s slots must be filled rather than printed literally.
    expect(formatArgs(["Warning: %s\n%s", "deprecation", "stack"]))
      .toBe("Warning: deprecation\nstack");
  });

  it("stringifies Error instances via stack or name/message", () => {
    const err = new Error("boom");
    const out = formatArgs([err]);
    // Either the stack (when present) or "Error: boom" fallback.
    expect(out.includes("boom")).toBe(true);
  });
});

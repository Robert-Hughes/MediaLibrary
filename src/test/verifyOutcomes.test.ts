/**
 * Unit tests for the verifyOutcomes reducer helpers extracted from
 * useMediaLibrary's apply_edits_progress handler.
 *
 * `mergeVerifyOutcomes` drives the VerifyOutcomeDialog's table: it
 * accepts the per-file outcome array emitted by the backend and folds
 * the "interesting" rows (Coerced/Mismatch/MissingPostWrite/
 * DeleteLingering) into the map keyed by relative path. Match and
 * DeleteOk are handled silently elsewhere — they must NOT land in the
 * map.
 *
 * `removeVerifyOutcome` is the dismissal/accept path: drop one
 * (path, tag) entry; remove the path key entirely when its list
 * empties.
 */
import { describe, it, expect } from "vitest";
import {
  isInterestingOutcome,
  mergeVerifyOutcomes,
  removeVerifyOutcome,
} from "../utils/verifyOutcomes";
import type { TagOutcome, TagOutcomeEntry } from "../types";

function outcome(tag: string, kind: TagOutcome["kind"]): TagOutcome {
  return {
    tag,
    kind,
    sent: null,
    before_display: null,
    observed_display: null,
    observed_raw: null,
    message: null,
  };
}

describe("isInterestingOutcome", () => {
  it("identifies the four user-attention kinds", () => {
    expect(isInterestingOutcome(outcome("a", "Coerced"))).toBe(true);
    expect(isInterestingOutcome(outcome("b", "Mismatch"))).toBe(true);
    expect(isInterestingOutcome(outcome("c", "MissingPostWrite"))).toBe(true);
    expect(isInterestingOutcome(outcome("d", "DeleteLingering"))).toBe(true);
  });

  it("filters out the silent kinds", () => {
    expect(isInterestingOutcome(outcome("a", "Match"))).toBe(false);
    expect(isInterestingOutcome(outcome("b", "DeleteOk"))).toBe(false);
  });
});

describe("mergeVerifyOutcomes", () => {
  it("returns the same reference when no outcomes are interesting", () => {
    const before = {};
    const after = mergeVerifyOutcomes(before, "a.jpg", [outcome("t", "Match")]);
    expect(after).toBe(before);
  });

  it("returns the same reference when the outcome list is empty", () => {
    const before = { "a.jpg": [{ tag: "x", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null } as TagOutcomeEntry] };
    const after = mergeVerifyOutcomes(before, "a.jpg", []);
    expect(after).toBe(before);
  });

  it("creates a new key when the file has no prior entries", () => {
    const before = {};
    const after = mergeVerifyOutcomes(before, "a.jpg", [
      outcome("t1", "Coerced"),
      outcome("t2", "Mismatch"),
    ]);
    expect(after["a.jpg"]).toHaveLength(2);
    expect(after["a.jpg"][0].tag).toBe("t1");
    expect(after["a.jpg"][0].kind).toBe("Coerced");
    expect(after["a.jpg"][1].kind).toBe("Mismatch");
  });

  it("ignores silent outcomes while keeping interesting ones", () => {
    const after = mergeVerifyOutcomes({}, "a.jpg", [
      outcome("t1", "Match"),
      outcome("t2", "Coerced"),
      outcome("t3", "DeleteOk"),
    ]);
    expect(after["a.jpg"]).toHaveLength(1);
    expect(after["a.jpg"][0].tag).toBe("t2");
  });

  it("appends to existing per-file list", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        { tag: "old", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
      ],
    };
    const after = mergeVerifyOutcomes(before, "a.jpg", [outcome("new", "Mismatch")]);
    expect(after["a.jpg"]).toHaveLength(2);
    expect(after["a.jpg"][0].tag).toBe("old");
    expect(after["a.jpg"][1].tag).toBe("new");
  });

  it("replaces an existing entry for the same tag (latest verdict wins)", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        { tag: "t", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: "first attempt" },
      ],
    };
    const after = mergeVerifyOutcomes(before, "a.jpg", [
      { ...outcome("t", "Mismatch"), message: "second attempt" },
    ]);
    expect(after["a.jpg"]).toHaveLength(1);
    expect(after["a.jpg"][0].kind).toBe("Mismatch");
    expect(after["a.jpg"][0].message).toBe("second attempt");
  });

  it("does not mutate the input map", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "x.jpg": [
        { tag: "x", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
      ],
    };
    const snapshot = JSON.stringify(before);
    mergeVerifyOutcomes(before, "x.jpg", [outcome("y", "Mismatch")]);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("removeVerifyOutcome", () => {
  it("returns the same reference when the path is absent", () => {
    const before = {};
    expect(removeVerifyOutcome(before, "missing.jpg", "t")).toBe(before);
  });

  it("returns the same reference when the tag is not in the file's list", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        { tag: "other", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
      ],
    };
    expect(removeVerifyOutcome(before, "a.jpg", "missing")).toBe(before);
  });

  it("removes a single matching tag and keeps the path key", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        { tag: "t1", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
        { tag: "t2", kind: "Mismatch", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
      ],
    };
    const after = removeVerifyOutcome(before, "a.jpg", "t1");
    expect(after["a.jpg"]).toHaveLength(1);
    expect(after["a.jpg"][0].tag).toBe("t2");
  });

  it("removes the path key when the list becomes empty", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        { tag: "only", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
      ],
    };
    const after = removeVerifyOutcome(before, "a.jpg", "only");
    expect(after["a.jpg"]).toBeUndefined();
    expect(Object.keys(after)).toHaveLength(0);
  });

  it("does not mutate the input map", () => {
    const before: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        { tag: "t", kind: "Coerced", sent: null, beforeDisplay: null, observedDisplay: null, observedRaw: null, message: null },
      ],
    };
    const snapshot = JSON.stringify(before);
    removeVerifyOutcome(before, "a.jpg", "t");
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

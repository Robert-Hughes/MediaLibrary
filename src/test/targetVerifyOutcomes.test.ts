// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { MetadataDraftTarget, MetadataTargetOutcome } from "../types";
import { targetDraftsFromWire } from "../targetDraftEdits";
import {
  emptyTargetVerifyOutcomes,
  replaceTargetVerifyOutcomesForFile,
  targetVerifyOutcomeFromBackend,
  targetVerifyPrimaryAction,
  validateTargetVerifyOutcomesAgainstDrafts,
} from "../targetVerifyOutcomes";
import { TargetVerifyOutcomesStore } from "../targetVerifyOutcomesStore";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";

const schema = (index?: number) => ({
  table: "Xmp::Main",
  tag_id: "dc:subject",
  ...(index === undefined ? {} : { index }),
});

const existing = (
  copy = 0,
  selector = `Subject-${copy}`,
): MetadataDraftTarget => ({
  kind: "ExistingOccurrence",
  occurrence_id: {
    document: null,
    path: "JPEG-APP1-XMP",
    runtime_tag_id: "dc:subject",
    tag_id_scope: {
      table: "Xmp::Main",
      tag_id: "dc:subject",
      index: null,
    },
    copy,
  },
  schema_id: schema(),
  write_target: { group1: "XMP-dc", group7: "ID-Test", tag_name: selector },
});

const newProperty = (index?: number): MetadataDraftTarget => ({
  kind: "NewProperty",
  schema_id: schema(index),
  write_target: { group1: "XMP-test", group7: "ID-Test", tag_name: "TestTag" },
});

const backend = (
  reconciliation: MetadataTargetOutcome["draft_reconciliation"],
  target: MetadataDraftTarget = existing(),
): MetadataTargetOutcome => ({
  target,
  draft_reconciliation: reconciliation,
  display_name: "Subject",
  kind: "Mismatch",
  sent: { kind: "Integer", value: 1 },
  before: { kind: "Integer", value: 0 },
  observed: { kind: "Real", value: 1 },
  message: "different wire value",
});

const draft = (target: MetadataDraftTarget) => ({
  target,
  edit: {
    intent: "Set" as const,
    value: { kind: "Text" as const, value: "draft" },
  },
});

describe("target-aware verification model", () => {
  it.each([
    [
      "ReadbackFailed",
      { kind: "Keep" } as const,
      null,
      "discard-pending-draft",
    ],
    [
      "ReadbackInvalid",
      { kind: "Keep" } as const,
      null,
      "discard-pending-draft",
    ],
    [
      "MissingPostWrite",
      { kind: "Keep" } as const,
      null,
      "discard-pending-draft",
    ],
    [
      "Blocked",
      { kind: "Blocked", reason: "stale" } as const,
      { kind: "Text", value: "observed" } as const,
      "discard-pending-draft",
    ],
    [
      "Mismatch",
      { kind: "Keep" } as const,
      { kind: "Text", value: "x" } as const,
      "accept-current-state",
    ],
    [
      "DeleteLingering",
      { kind: "Keep" } as const,
      { kind: "Text", value: "x" } as const,
      "accept-current-state",
    ],
    [
      "Mismatch",
      { kind: "Keep" } as const,
      { kind: "Null" } as const,
      "accept-current-state",
    ],
  ])(
    "selects the primary action for %s",
    (kind, reconciliation, observed, expected) => {
      const entry = targetVerifyOutcomeFromBackend("a.jpg", {
        ...backend(reconciliation),
        kind,
        observed,
      })!;
      expect(targetVerifyPrimaryAction(entry)).toBe(expected);
    },
  );

  it("maps Clear, Keep, Replace, and Blocked structurally", () => {
    expect(
      targetVerifyOutcomeFromBackend("a.jpg", backend({ kind: "Clear" })),
    ).toBeNull();

    const keepTarget = existing(1, "KeepSelector");
    const keep = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Keep" }, keepTarget),
    )!;
    expect(keep.currentTarget).toEqual(keepTarget);
    expect(keep.originalTarget).toEqual(keepTarget);

    const replacement = existing(2, "RuntimeReplacement");
    const replace = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Replace", target: replacement }, newProperty()),
    )!;
    expect(replace.originalTarget.kind).toBe("NewProperty");
    expect(replace.currentTarget).toEqual(replacement);
    expect(replace.currentTarget).toMatchObject({
      occurrence_id: { copy: 2 },
      schema_id: schema(),
      write_target: {
        group1: "XMP-dc",
        group7: "ID-Test",
        tag_name: "RuntimeReplacement",
      },
    });

    const blocked = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Blocked", reason: "stale occurrence" }, keepTarget),
    )!;
    expect(blocked.currentTarget).toEqual(keepTarget);
    expect(blocked.reconciliation).toEqual({
      kind: "Blocked",
      reason: "stale occurrence",
    });
  });

  it("keeps same-schema siblings and absent/zero indices distinct", () => {
    expect(metadataDraftTargetSlotToken(existing(0))).not.toBe(
      metadataDraftTargetSlotToken(existing(1)),
    );
    expect(metadataDraftTargetSlotToken(newProperty())).not.toBe(
      metadataDraftTargetSlotToken(newProperty(0)),
    );
  });

  it.each([
    "__proto__",
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
  ])("treats reserved path %s as ordinary data", (path) => {
    const entry = targetVerifyOutcomeFromBackend(
      path,
      backend({ kind: "Keep" }),
    )!;
    const snapshot = replaceTargetVerifyOutcomesForFile(
      emptyTargetVerifyOutcomes(),
      path,
      [entry],
    );
    expect(Object.keys(snapshot)).toEqual([path]);
    expect(Object.values(snapshot[path])).toEqual([entry]);
  });

  it("validates the exact complete persisted current target", () => {
    const replacement = existing(3, "ExactRuntimeSelector");
    const entry = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Replace", target: replacement }, newProperty()),
    )!;
    const drafts = targetDraftsFromWire({ "a.jpg": [draft(replacement)] });
    expect(() =>
      validateTargetVerifyOutcomesAgainstDrafts("a.jpg", [entry], drafts),
    ).not.toThrow();
    expect(() =>
      validateTargetVerifyOutcomesAgainstDrafts("a.jpg", [entry], {}),
    ).toThrow(/slot is absent/);
    const changed = existing(3, "ChangedSelector");
    expect(() =>
      validateTargetVerifyOutcomesAgainstDrafts(
        "a.jpg",
        [entry],
        targetDraftsFromWire({ "a.jpg": [draft(changed)] }),
      ),
    ).toThrow(/snapshot changed/);
  });
});

describe("target verification store", () => {
  it("preserves exact-repeat references and notifies once per mutation", () => {
    const store = new TargetVerifyOutcomesStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const entry = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Keep" }),
    )!;
    expect(store.replaceFile("a.jpg", [entry])).toBe(true);
    const first = store.getAll();
    expect(store.replaceFile("a.jpg", [structuredClone(entry)])).toBe(false);
    expect(store.getAll()).toBe(first);
    expect(listener).toHaveBeenCalledOnce();

    const changed = { ...entry, message: "changed" };
    expect(store.replaceFile("a.jpg", [changed])).toBe(true);
    expect(store.getAll()).not.toBe(first);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("defensively clones and freezes nested targets and values", () => {
    const store = new TargetVerifyOutcomesStore();
    const entry = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Keep" }),
    )!;
    const mutable = structuredClone(entry);
    store.replaceFile("a.jpg", [mutable]);
    mutable.displayName = "mutated caller";
    if (mutable.currentTarget.kind === "ExistingOccurrence") {
      mutable.currentTarget.write_target.tag_name = "mutated caller";
    }
    const stored = Object.values(store.getFile("a.jpg")!)[0];
    expect(stored.displayName).toBe("Subject");
    expect(Object.isFrozen(stored.currentTarget)).toBe(true);
    expect(Object.isFrozen(stored.sent)).toBe(true);
  });

  it("clears the projected snapshot without redundant notification", () => {
    const store = new TargetVerifyOutcomesStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const entry = targetVerifyOutcomeFromBackend(
      "a.jpg",
      backend({ kind: "Keep" }),
    )!;
    store.replaceFile("a.jpg", [entry]);

    expect(store.clear()).toBe(true);
    expect(store.getFile("a.jpg")).toBeUndefined();
    expect(store.clear()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

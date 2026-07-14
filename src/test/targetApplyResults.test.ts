// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ImageMetadataOccurrencesStore,
  ImageMetadataStore,
  type ImageMetadata,
  type MetadataApplyEditsResultV5,
  type MetadataApplyFileResultV5,
  type MetadataDraftEntryV5,
  type MetadataOccurrence,
  type MetadataTargetOutcome,
} from "../types";
import {
  applyTargetApplyFileResultV5,
  applyTargetApplyResultV5,
  prepareTargetApplyFileResultV5,
  type TargetApplyResultStores,
} from "../targetApplyResults";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import { TargetVerifyOutcomesStoreV5 } from "../targetVerifyOutcomesStore";

const path = "photo.jpg";
const schema = (table = "Exif::Main") => ({ table, tag_id: "282" });
const target = (group1 = "IFD0") => ({
  kind: "ExistingOccurrence" as const,
  occurrence_id: {
    document: null,
    path: "JPEG-APP1-IFD0",
    tag_id: "282",
    copy: 0,
  },
  schema_id: schema(),
  write_target: { group1, tag_name: "XResolution" },
});
const draft = (numerator = 1, denominator = 2): MetadataDraftEntryV5 => ({
  target: target(),
  edit: {
    intent: "Set",
    value: { kind: "Rational", value: { numerator, denominator } },
    display: "one half",
  },
});
const occurrence = (numerator = 1, denominator = 2): MetadataOccurrence => ({
  id: { ...target().occurrence_id },
  value: { kind: "Rational", value: { numerator, denominator } },
  tag_info: {
    id: schema(),
    group: "IFD0",
    name: "XResolution",
    writable: true,
    kind: { kind: "Rational" },
    description: null,
  },
  write_target: { ...target().write_target },
});
const outcome = (): MetadataTargetOutcome => ({
  target: target(),
  draft_reconciliation: { kind: "Keep" },
  display_name: "IFD0:XResolution",
  kind: "Match",
  sent: { kind: "Rational", value: { numerator: 1, denominator: 2 } },
  before: null,
  observed: { kind: "Rational", value: { numerator: 1, denominator: 2 } },
  message: null,
});
const fresh = (relativePath = path): ImageMetadata => ({
  relative_path: relativePath,
  occurrences: [occurrence()],
  metadata: [{ id: schema(), value: { kind: "Text", value: "compatibility" } }],
});
const file = (
  overrides: Partial<MetadataApplyFileResultV5> = {},
): MetadataApplyFileResultV5 => ({
  relative_path: path,
  applied: true,
  error: null,
  warning: null,
  fresh_image_metadata: fresh(),
  target_outcomes: [outcome()],
  persisted_draft_entries: [draft()],
  ...overrides,
});
const batch = (
  files: MetadataApplyFileResultV5[],
  overrides: Partial<MetadataApplyEditsResultV5> = {},
): MetadataApplyEditsResultV5 => ({
  files,
  cancelled: false,
  aborted: false,
  abort_reason: null,
  ...overrides,
});
const stores = (): TargetApplyResultStores => ({
  drafts: new TargetDraftEditsStore(),
  occurrences: new ImageMetadataOccurrencesStore(),
  compatibility: new ImageMetadataStore(),
  verification: new TargetVerifyOutcomesStoreV5(),
});

describe("inactive target apply file results", () => {
  it("obeys independent null authority fields and empty draft removal", () => {
    const state = stores();
    state.drafts.replaceMetadataFile(path, [draft()]);
    state.occurrences.set(path, [occurrence()]);
    state.compatibility.set(path, {});
    const beforeDrafts = state.drafts.getAllMetadata();
    const beforeOccurrences = state.occurrences.get(path);
    const beforeCompatibility = state.compatibility.get(path);

    const none = applyTargetApplyFileResultV5(
      file({ persisted_draft_entries: null, fresh_image_metadata: null }),
      state,
    );
    expect(none).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
      compatibilityChanged: false,
    });
    expect(state.drafts.getAllMetadata()).toBe(beforeDrafts);
    expect(state.occurrences.get(path)).toBe(beforeOccurrences);
    expect(state.compatibility.get(path)).toBe(beforeCompatibility);

    expect(
      applyTargetApplyFileResultV5(
        file({
          persisted_draft_entries: [],
          fresh_image_metadata: null,
          target_outcomes: [],
        }),
        state,
      ).draftsChanged,
    ).toBe(true);
    expect(state.drafts.getMetadataFile(path)).toBeUndefined();
  });

  it("applies present authoritative state even for semantic failure", () => {
    const state = stores();
    const result = file({
      applied: false,
      error: "semantic mismatch",
      persisted_draft_entries: [draft(2, 4)],
    });
    const applied = applyTargetApplyFileResultV5(result, state);
    expect(applied).toMatchObject({
      draftsChanged: true,
      occurrencesChanged: true,
      compatibilityChanged: true,
    });
    expect(Object.values(state.drafts.getMetadataFile(path)!)[0]).toEqual(
      draft(2, 4),
    );
    expect(state.occurrences.get(path)).toEqual(
      result.fresh_image_metadata!.occurrences,
    );
  });

  it("uses reconciliation only for target verification", () => {
    const state = stores();
    state.drafts.replaceMetadataFile(path, [draft()]);
    const clear = outcome();
    clear.draft_reconciliation = { kind: "Clear" };
    applyTargetApplyFileResultV5(
      file({
        persisted_draft_entries: null,
        fresh_image_metadata: null,
        target_outcomes: [clear],
      }),
      state,
    );
    expect(state.drafts.getMetadataFile(path)).toBeDefined();

    const replacement = { ...draft(3, 5), target: target("IFD1") };
    const replace = outcome();
    replace.target = { kind: "NewProperty", schema_id: schema() };
    replace.draft_reconciliation = { kind: "Replace", target: target("IFD1") };
    applyTargetApplyFileResultV5(
      file({
        persisted_draft_entries: [replacement],
        fresh_image_metadata: null,
        target_outcomes: [replace],
      }),
      state,
    );
    expect(Object.values(state.drafts.getMetadataFile(path)!)).toEqual([
      replacement,
    ]);
  });

  it("deeply clones payload state and returned outcomes", () => {
    const state = stores();
    const source = file();
    const sourceBefore = structuredClone(source);
    const summary = applyTargetApplyFileResultV5(source, state);
    source.persisted_draft_entries![0].target.schema_id.table = "mutated";
    source.fresh_image_metadata!.occurrences[0].value = {
      kind: "Text",
      value: "mutated",
    };
    source.fresh_image_metadata!.metadata[0].value = {
      kind: "Text",
      value: "mutated",
    };
    source.target_outcomes[0].display_name = "mutated";
    expect(Object.values(state.drafts.getMetadataFile(path)!)[0]).toEqual(
      sourceBefore.persisted_draft_entries![0],
    );
    expect(state.occurrences.get(path)).toEqual(
      sourceBefore.fresh_image_metadata!.occurrences,
    );
    expect(summary.targetOutcomes).toEqual(sourceBefore.target_outcomes);
    summary.targetOutcomes[0].display_name = "summary mutation";
    expect(source.target_outcomes[0].display_name).toBe("mutated");
  });

  it("supports reserved paths and leaves unrelated paths unchanged", () => {
    const state = stores();
    state.drafts.replaceMetadataFile("other.jpg", [draft()]);
    state.occurrences.set("other.jpg", [occurrence()]);
    state.compatibility.set("other.jpg", {});
    const otherDraft = state.drafts.getMetadataFile("other.jpg");
    const otherOccurrences = state.occurrences.get("other.jpg");
    const reserved = file({
      relative_path: "__proto__",
      fresh_image_metadata: fresh("__proto__"),
    });
    applyTargetApplyFileResultV5(reserved, state);
    expect(state.drafts.getMetadataFile("__proto__")).toBeDefined();
    expect(state.drafts.getMetadataFile("other.jpg")).toBe(otherDraft);
    expect(state.occurrences.get("other.jpg")).toBe(otherOccurrences);
  });
});

describe("target apply exact idempotency and notifications", () => {
  it("notifies each changed store once, then not at all for progress/final repetition", () => {
    const state = stores();
    const draftListener = vi.fn();
    const occurrenceListener = vi.fn();
    const compatibilityListener = vi.fn();
    state.drafts.subscribe(draftListener);
    state.occurrences.subscribe(path, occurrenceListener);
    state.compatibility.subscribe(path, compatibilityListener);
    const first = applyTargetApplyFileResultV5(file(), state);
    expect(first).toMatchObject({
      draftsChanged: true,
      occurrencesChanged: true,
      compatibilityChanged: true,
    });
    expect(
      [draftListener, occurrenceListener, compatibilityListener].map(
        (listener) => listener.mock.calls.length,
      ),
    ).toEqual([1, 1, 1]);

    const final = applyTargetApplyResultV5(batch([file()]), state);
    expect(final.files[0]).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
      compatibilityChanged: false,
    });
    expect(
      [draftListener, occurrenceListener, compatibilityListener].map(
        (listener) => listener.mock.calls.length,
      ),
    ).toEqual([1, 1, 1]);
  });

  it("updates only independently changed representations", () => {
    const state = stores();
    applyTargetApplyFileResultV5(file(), state);
    const draftListener = vi.fn();
    const occurrenceListener = vi.fn();
    const compatibilityListener = vi.fn();
    state.drafts.subscribe(draftListener);
    state.occurrences.subscribe(path, occurrenceListener);
    state.compatibility.subscribe(path, compatibilityListener);

    applyTargetApplyFileResultV5(
      file({ persisted_draft_entries: [draft(2, 4)] }),
      state,
    );
    expect(
      [draftListener, occurrenceListener, compatibilityListener].map(
        (listener) => listener.mock.calls.length,
      ),
    ).toEqual([1, 0, 0]);
    const changedOccurrence = fresh();
    changedOccurrence.occurrences = [occurrence(2, 4)];
    applyTargetApplyFileResultV5(
      file({
        persisted_draft_entries: [draft(2, 4)],
        fresh_image_metadata: changedOccurrence,
      }),
      state,
    );
    expect(
      [draftListener, occurrenceListener, compatibilityListener].map(
        (listener) => listener.mock.calls.length,
      ),
    ).toEqual([1, 1, 0]);
    const changedCompatibility = structuredClone(changedOccurrence);
    changedCompatibility.metadata[0].value = { kind: "Text", value: "changed" };
    applyTargetApplyFileResultV5(
      file({
        persisted_draft_entries: [draft(2, 4)],
        fresh_image_metadata: changedCompatibility,
      }),
      state,
    );
    expect(
      [draftListener, occurrenceListener, compatibilityListener].map(
        (listener) => listener.mock.calls.length,
      ),
    ).toEqual([1, 1, 1]);
  });

  it("ignores object insertion order and replaces loading once", () => {
    const state = stores();
    const occurrenceListener = vi.fn();
    state.occurrences.subscribe(path, occurrenceListener);
    applyTargetApplyFileResultV5(
      file({ persisted_draft_entries: null, target_outcomes: [] }),
      state,
    );
    expect(occurrenceListener).toHaveBeenCalledOnce();
    const reordered = structuredClone(
      file({ persisted_draft_entries: null, target_outcomes: [] }),
    );
    reordered.fresh_image_metadata!.occurrences[0].value = Object.fromEntries([
      ["value", { denominator: 2, numerator: 1 }],
      ["kind", "Rational"],
    ]) as MetadataOccurrence["value"];
    expect(
      applyTargetApplyFileResultV5(reordered, state).occurrencesChanged,
    ).toBe(false);
    expect(occurrenceListener).toHaveBeenCalledOnce();
  });
});

describe("complete target apply batches", () => {
  it("handles empty, cancelled, and aborted batches while preserving result order", () => {
    const state = stores();
    expect(applyTargetApplyResultV5(batch([]), state).files).toEqual([]);
    const a = file({
      relative_path: "a.jpg",
      fresh_image_metadata: fresh("a.jpg"),
    });
    const b = file({
      relative_path: "b.jpg",
      fresh_image_metadata: fresh("b.jpg"),
    });
    const cancelled = applyTargetApplyResultV5(
      batch([b, a], { cancelled: true }),
      state,
    );
    expect(cancelled.files.map((entry) => entry.relativePath)).toEqual([
      "b.jpg",
      "a.jpg",
    ]);
    expect(cancelled).toMatchObject({
      cancelled: true,
      aborted: false,
      abortReason: null,
    });
    const aborted = applyTargetApplyResultV5(
      batch([a], { aborted: true, abort_reason: "fatal" }),
      state,
    );
    expect(aborted).toMatchObject({
      cancelled: false,
      aborted: true,
      abortReason: "fatal",
    });
  });

  it("validates and prepares every file before mutating any store", () => {
    const state = stores();
    const first = file({
      relative_path: "first.jpg",
      fresh_image_metadata: fresh("first.jpg"),
    });
    const invalid = file({
      relative_path: "bad.jpg",
      fresh_image_metadata: fresh("different.jpg"),
    });
    expect(() =>
      applyTargetApplyResultV5(batch([first, invalid]), state),
    ).toThrow();
    expect(state.drafts.getAllMetadata()).toEqual({});
    expect([...state.occurrences.entries()]).toEqual([]);
    expect([...state.compatibility.entries()]).toEqual([]);
  });

  it("rejects duplicate paths, is repeatable, and does not mutate its source", () => {
    const state = stores();
    expect(() =>
      applyTargetApplyResultV5(batch([file(), file()]), state),
    ).toThrow(/duplicate file/);
    const source = batch([file()]);
    const before = structuredClone(source);
    const first = applyTargetApplyResultV5(source, state);
    const second = applyTargetApplyResultV5(source, state);
    expect(first.files[0]).toMatchObject({
      draftsChanged: true,
      occurrencesChanged: true,
      compatibilityChanged: true,
    });
    expect(second.files[0]).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
      compatibilityChanged: false,
    });
    expect(source).toEqual(before);
  });

  it("preparation is pure and rejects malformed direct input", () => {
    const source = file();
    const before = structuredClone(source);
    expect(prepareTargetApplyFileResultV5(source)).toMatchObject({
      relativePath: path,
    });
    expect(source).toEqual(before);
    expect(() =>
      prepareTargetApplyFileResultV5({ ...source, applied: false }),
    ).toThrow();
  });
});

describe("target verification result integration", () => {
  it("authoritatively installs, clears, and replaces per-file outcomes", () => {
    const state = stores();
    const listener = vi.fn();
    state.verification.subscribe(listener);
    applyTargetApplyFileResultV5(file(), state);
    expect(Object.values(state.verification.getFile(path)!)).toHaveLength(1);
    const progressSnapshot = state.verification.getAll();

    applyTargetApplyResultV5(batch([file()]), state);
    expect(state.verification.getAll()).toBe(progressSnapshot);
    expect(listener).toHaveBeenCalledOnce();

    const different = outcome();
    different.message = "authoritative final difference";
    applyTargetApplyResultV5(
      batch([file({ target_outcomes: [different] })]),
      state,
    );
    expect(Object.values(state.verification.getFile(path)!)[0].message).toBe(
      "authoritative final difference",
    );

    applyTargetApplyFileResultV5(
      file({ target_outcomes: [], persisted_draft_entries: [draft()] }),
      state,
    );
    expect(state.verification.getFile(path)).toBeUndefined();
  });

  it("Clear removes an earlier outcome and final-only results install one", () => {
    const state = stores();
    applyTargetApplyFileResultV5(file(), state);
    const clear = outcome();
    clear.draft_reconciliation = { kind: "Clear" };
    applyTargetApplyFileResultV5(
      file({ target_outcomes: [clear], persisted_draft_entries: [] }),
      state,
    );
    expect(state.verification.getFile(path)).toBeUndefined();

    applyTargetApplyResultV5(batch([file()]), state);
    expect(Object.values(state.verification.getFile(path)!)).toHaveLength(1);
  });

  it("validates replacement against the persisted replacement target", () => {
    const state = stores();
    const replacement = target("IFD1");
    const replace = outcome();
    replace.target = { kind: "NewProperty", schema_id: schema() };
    replace.draft_reconciliation = { kind: "Replace", target: replacement };
    const replacementDraft = { ...draft(), target: replacement };
    applyTargetApplyFileResultV5(
      file({
        target_outcomes: [replace],
        persisted_draft_entries: [replacementDraft],
      }),
      state,
    );
    expect(Object.values(state.verification.getFile(path)!)[0]).toMatchObject({
      originalTarget: { kind: "NewProperty" },
      currentTarget: replacement,
    });

    expect(() =>
      applyTargetApplyFileResultV5(
        file({
          target_outcomes: [replace],
          persisted_draft_entries: [],
        }),
        state,
      ),
    ).toThrow(/contract error/);
    expect(Object.values(state.verification.getFile(path)!)[0]).toMatchObject({
      currentTarget: replacement,
    });

    expect(() =>
      applyTargetApplyFileResultV5(
        file({
          target_outcomes: [replace],
          persisted_draft_entries: [{ ...draft(), target: target("Changed") }],
        }),
        state,
      ),
    ).toThrow(/snapshot changed/);
    expect(Object.values(state.verification.getFile(path)!)[0]).toMatchObject({
      currentTarget: replacement,
    });
  });

  it("rejects invalid replacement snapshots before any single-file mutation", () => {
    const state = stores();
    const replacement = target("IFD1");
    const replace = outcome();
    replace.target = { kind: "NewProperty", schema_id: schema() };
    replace.draft_reconciliation = { kind: "Replace", target: replacement };
    const replacementDraft = { ...draft(), target: replacement };
    applyTargetApplyFileResultV5(
      file({
        target_outcomes: [replace],
        persisted_draft_entries: [replacementDraft],
      }),
      state,
    );

    const before = {
      drafts: state.drafts.getAllMetadata(),
      verification: state.verification.getAll(),
      occurrences: state.occurrences.get(path),
      compatibility: state.compatibility.get(path),
    };
    const listeners = {
      drafts: vi.fn(),
      verification: vi.fn(),
      occurrences: vi.fn(),
      compatibility: vi.fn(),
    };
    state.drafts.subscribe(listeners.drafts);
    state.verification.subscribe(listeners.verification);
    state.occurrences.subscribe(path, listeners.occurrences);
    state.compatibility.subscribe(path, listeners.compatibility);

    const missing = file({
      target_outcomes: [replace],
      persisted_draft_entries: [],
      fresh_image_metadata: {
        ...fresh(),
        occurrences: [occurrence(9, 10)],
        metadata: [
          { id: schema(), value: { kind: "Text", value: "must not install" } },
        ],
      },
    });
    const missingBefore = structuredClone(missing);
    expect(() => applyTargetApplyFileResultV5(missing, state)).toThrow(
      /slot is absent/,
    );
    expect(missing).toEqual(missingBefore);

    const changed = file({
      target_outcomes: [replace],
      persisted_draft_entries: [{ ...draft(), target: target("Changed") }],
    });
    expect(() => applyTargetApplyFileResultV5(changed, state)).toThrow(
      /snapshot changed/,
    );

    expect(state.drafts.getAllMetadata()).toBe(before.drafts);
    expect(state.verification.getAll()).toBe(before.verification);
    expect(state.occurrences.get(path)).toBe(before.occurrences);
    expect(state.compatibility.get(path)).toBe(before.compatibility);
    expect(
      Object.values(listeners).every((listener) => !listener.mock.calls.length),
    ).toBe(true);
  });

  it("validates null persisted snapshots only against the current exact target", () => {
    const state = stores();
    state.drafts.replaceMetadataFile(path, [draft()]);
    expect(() =>
      applyTargetApplyFileResultV5(
        file({
          persisted_draft_entries: null,
          fresh_image_metadata: null,
        }),
        state,
      ),
    ).not.toThrow();

    const empty = stores();
    const snapshots = {
      drafts: empty.drafts.getAllMetadata(),
      verification: empty.verification.getAll(),
    };
    const draftListener = vi.fn();
    const verificationListener = vi.fn();
    empty.drafts.subscribe(draftListener);
    empty.verification.subscribe(verificationListener);
    expect(() =>
      applyTargetApplyFileResultV5(
        file({
          persisted_draft_entries: null,
          fresh_image_metadata: null,
        }),
        empty,
      ),
    ).toThrow(/slot is absent/);
    expect(empty.drafts.getAllMetadata()).toBe(snapshots.drafts);
    expect(empty.verification.getAll()).toBe(snapshots.verification);
    expect(draftListener).not.toHaveBeenCalled();
    expect(verificationListener).not.toHaveBeenCalled();
  });
});

describe("atomic target apply verification batches", () => {
  it("preflights every verification contract before mutating the first file", () => {
    const state = stores();
    const firstPath = "first.jpg";
    const secondPath = "second.jpg";
    const initial = [firstPath, secondPath].map((relativePath) =>
      file({
        relative_path: relativePath,
        fresh_image_metadata: fresh(relativePath),
      }),
    );
    applyTargetApplyResultV5(batch(initial), state);
    const before = {
      drafts: state.drafts.getAllMetadata(),
      verification: state.verification.getAll(),
      firstOccurrences: state.occurrences.get(firstPath),
      secondOccurrences: state.occurrences.get(secondPath),
      firstCompatibility: state.compatibility.get(firstPath),
      secondCompatibility: state.compatibility.get(secondPath),
    };
    const listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    state.drafts.subscribe(listeners[0]);
    state.verification.subscribe(listeners[1]);
    state.occurrences.subscribe(firstPath, listeners[2]);
    state.occurrences.subscribe(secondPath, listeners[3]);
    state.compatibility.subscribe(firstPath, listeners[4]);
    state.compatibility.subscribe(secondPath, listeners[5]);

    const validFirst = file({
      relative_path: firstPath,
      fresh_image_metadata: fresh(firstPath),
      persisted_draft_entries: [draft(3, 4)],
    });
    const invalidSecond = file({
      relative_path: secondPath,
      fresh_image_metadata: fresh(secondPath),
      persisted_draft_entries: [],
    });
    expect(() =>
      applyTargetApplyResultV5(batch([validFirst, invalidSecond]), state),
    ).toThrow(/slot is absent/);

    expect(state.drafts.getAllMetadata()).toBe(before.drafts);
    expect(state.verification.getAll()).toBe(before.verification);
    expect(state.occurrences.get(firstPath)).toBe(before.firstOccurrences);
    expect(state.occurrences.get(secondPath)).toBe(before.secondOccurrences);
    expect(state.compatibility.get(firstPath)).toBe(before.firstCompatibility);
    expect(state.compatibility.get(secondPath)).toBe(
      before.secondCompatibility,
    );
    expect(
      listeners.every((listener) => listener.mock.calls.length === 0),
    ).toBe(true);
    expect(Object.values(state.verification.getFile(firstPath)!)).toHaveLength(
      1,
    );
    expect(Object.values(state.verification.getFile(secondPath)!)).toHaveLength(
      1,
    );
  });
});

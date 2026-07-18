// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  ImageMetadataOccurrencesStore,
  type ImageMetadata,
  type MetadataApplyResult,
  type MetadataApplyFileResult,
  type MetadataTargetDraftEntry,
  type MetadataOccurrence,
  type MetadataTargetOutcome,
} from "../types";
import {
  applyTargetApplyFileResult,
  applyTargetApplyResult,
  prepareTargetApplyFileResult,
  type TargetApplyResultStores,
} from "../targetApplyResults";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import { TargetVerifyOutcomesStore } from "../targetVerifyOutcomesStore";

const path = "photo.jpg";
const schema = { table: "Exif::Main", tag_id: "282" };
const target = {
  kind: "ExistingOccurrence" as const,
  occurrence_id: {
    document: null,
    path: "JPEG-APP1-IFD0",
    runtime_tag_id: "282",
    tag_id_scope: { table: "TestFixture::Runtime", tag_id: "282", index: null },
    copy: 0,
  },
  schema_id: schema,
  write_target: { group1: "IFD0", group7: "ID-Test", tag_name: "XResolution" },
};

function draft(numerator = 1): MetadataTargetDraftEntry {
  return {
    target: structuredClone(target),
    edit: {
      intent: "Set",
      value: { kind: "Rational", value: { numerator, denominator: 2 } },
      display: `${numerator}/2`,
    },
  };
}

function occurrence(numerator = 1): MetadataOccurrence {
  return {
    id: structuredClone(target.occurrence_id),
    schema_id: structuredClone(schema),
    value: { kind: "Rational", value: { numerator, denominator: 2 } },
    tag_info: {
      id: structuredClone(schema),
      group: "IFD0",
      name: "XResolution",
      writable: true,
      kind: { kind: "Rational" },
      description: null,
      storage_count: undefined,
    },
    observed_selector: structuredClone(target.write_target),
    write_target: structuredClone(target.write_target),
  };
}

function fresh(numerator = 1, relativePath = path): ImageMetadata {
  return { relative_path: relativePath, occurrences: [occurrence(numerator)] };
}

function outcome(): MetadataTargetOutcome {
  return {
    target: structuredClone(target),
    draft_reconciliation: { kind: "Keep" },
    display_name: "IFD0:XResolution",
    kind: "Match",
    sent: { kind: "Rational", value: { numerator: 1, denominator: 2 } },
    before: null,
    observed: { kind: "Rational", value: { numerator: 1, denominator: 2 } },
    message: null,
  };
}

function file(
  overrides: Partial<MetadataApplyFileResult> = {},
): MetadataApplyFileResult {
  return {
    relative_path: path,
    applied: true,
    error: null,
    warning: null,
    fresh_image_metadata: fresh(),
    target_outcomes: [outcome()],
    persisted_draft_entries: [draft()],
    ...overrides,
  };
}

function stores(): TargetApplyResultStores {
  return {
    drafts: new TargetDraftEditsStore(),
    occurrences: new ImageMetadataOccurrencesStore(),
    verification: new TargetVerifyOutcomesStore(),
  };
}

function batch(files: MetadataApplyFileResult[]): MetadataApplyResult {
  return {
    files,
    cancelled: false,
    aborted: false,
    abort_reason: null,
  };
}

describe("target apply occurrence refresh", () => {
  it("respects null authority fields", () => {
    const state = stores();
    state.drafts.replaceMetadataFile(path, [draft()]);
    const existing = [occurrence()];
    state.occurrences.set(path, existing);

    const application = applyTargetApplyFileResult(
      file({ persisted_draft_entries: null, fresh_image_metadata: null }),
      state,
    );

    expect(application).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
    });
    expect(state.occurrences.get(path)).toBe(existing);
    expect(state.drafts.getMetadataFile(path)).toBeDefined();
  });

  it("replaces authoritative occurrences and reports only occurrencesChanged", () => {
    const state = stores();
    state.occurrences.set(path, [occurrence(1)]);
    const listener = vi.fn();
    state.occurrences.subscribe(path, listener);

    const application = applyTargetApplyFileResult(
      file({
        fresh_image_metadata: fresh(3),
        persisted_draft_entries: null,
        target_outcomes: [],
      }),
      state,
    );

    expect(application).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: true,
    });
    expect(application).not.toHaveProperty("compatibilityChanged");
    expect(state.occurrences.get(path)).toEqual([occurrence(3)]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("does not replace exact-equal occurrence snapshots", () => {
    const state = stores();
    const existing = [occurrence(2)];
    state.occurrences.set(path, existing);
    const listener = vi.fn();
    state.occurrences.subscribe(path, listener);

    const application = applyTargetApplyFileResult(
      file({
        fresh_image_metadata: fresh(2),
        persisted_draft_entries: null,
        target_outcomes: [],
      }),
      state,
    );

    expect(application.occurrencesChanged).toBe(false);
    expect(state.occurrences.get(path)).toBe(existing);
    expect(listener).not.toHaveBeenCalled();
  });

  it("updates persisted drafts and verification outcomes together", () => {
    const state = stores();
    state.drafts.replaceMetadataFile(path, [draft(1)]);
    const application = applyTargetApplyFileResult(
      file({ persisted_draft_entries: [draft(4)] }),
      state,
    );
    expect(application.draftsChanged).toBe(true);
    expect(Object.values(state.drafts.getMetadataFile(path)!)[0]).toEqual(
      draft(4),
    );
    expect(Object.keys(state.verification.getFile(path) ?? {})).toHaveLength(1);
  });

  it("prepares immutable occurrence-only applications", () => {
    const raw = file({ fresh_image_metadata: fresh(5) });
    const prepared = prepareTargetApplyFileResult(raw);
    raw.fresh_image_metadata!.occurrences[0].value = {
      kind: "Text",
      value: "mutated",
    };
    expect(prepared.occurrences).toEqual([occurrence(5)]);
    expect(prepared).not.toHaveProperty("compatibility");
  });

  it("validates every batch file before mutating any store", () => {
    const state = stores();
    const firstPath = "first.jpg";
    state.occurrences.set(firstPath, [occurrence(9)]);
    const before = state.occurrences.get(firstPath);
    const validFirst = file({
      relative_path: firstPath,
      fresh_image_metadata: fresh(1, firstPath),
      target_outcomes: [],
      persisted_draft_entries: null,
    });
    const invalidSecond = {
      ...file({
        relative_path: "second.jpg",
        fresh_image_metadata: fresh(2, "second.jpg"),
        target_outcomes: [],
        persisted_draft_entries: null,
      }),
      fresh_image_metadata: {
        ...fresh(2, "second.jpg"),
        metadata: [],
      },
    };

    expect(() =>
      applyTargetApplyResult(
        batch([validFirst, invalidSecond as never]),
        state,
      ),
    ).toThrow(/fresh_image_metadata/);
    expect(state.occurrences.get(firstPath)).toBe(before);
  });

  it("preserves final cancelled and aborted result fields", () => {
    const state = stores();
    expect(
      applyTargetApplyResult(
        {
          files: [],
          cancelled: true,
          aborted: false,
          abort_reason: null,
        },
        state,
      ),
    ).toEqual({
      files: [],
      cancelled: true,
      aborted: false,
      abortReason: null,
    });
  });
});

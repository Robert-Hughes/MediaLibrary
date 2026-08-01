// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  FileMetadataOccurrencesStore,
  type FileMetadata,
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
import { targetDraftsFromWire } from "../targetDraftEdits";
import { TargetVerifyOutcomesStore } from "../targetVerifyOutcomesStore";

const path = "file.jpg";
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

function fresh(numerator = 1, relativePath = path): FileMetadata {
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
    fresh_file_metadata: fresh(),
    target_outcomes: [outcome()],
    persisted_draft_entries: [draft()],
    ...overrides,
  };
}

function stores(): TargetApplyResultStores {
  const occurrences = new FileMetadataOccurrencesStore();
  occurrences.add(path);
  return {
    drafts: new TargetDraftEditsStore(),
    occurrences,
    verification: new TargetVerifyOutcomesStore(),
  };
}

function batch(files: MetadataApplyFileResult[]): MetadataApplyResult {
  return {
    summary: {
      requested: files.length,
      selected: files.length,
      completed: files.length,
      applied: files.filter((file) => file.applied).length,
      failed: files.filter((file) => !file.applied).length,
      warning_count: files.filter((file) => file.warning !== null).length,
      cancelled: false,
      aborted: false,
      abort_reason: null,
      delivery_failure_count: files.length,
    },
    undelivered_files: files,
    complete_delivery_failed: false,
  };
}

describe("target apply occurrence refresh", () => {
  it("respects null authority fields", () => {
    const state = stores();
    state.drafts.replaceMetadataFile(path, [draft()]);
    const existing = [occurrence()];
    state.occurrences.set(path, existing);

    const application = applyTargetApplyFileResult(
      file({ persisted_draft_entries: null, fresh_file_metadata: null }),
      state,
    );

    expect(application).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
    });
    expect(state.occurrences.get(path)).toBe(existing);
    expect(state.drafts.getMetadataFile(path)).toBeDefined();
  });

  it("leaves authoritative occurrences to the Rust session delta", () => {
    const state = stores();
    state.occurrences.set(path, [occurrence(1)]);
    const listener = vi.fn();
    state.occurrences.subscribe(path, listener);

    const application = applyTargetApplyFileResult(
      file({
        fresh_file_metadata: fresh(3),
        persisted_draft_entries: null,
        target_outcomes: [],
      }),
      state,
    );

    expect(application).toMatchObject({
      draftsChanged: false,
      occurrencesChanged: false,
    });
    expect(application).not.toHaveProperty("compatibilityChanged");
    expect(state.occurrences.get(path)).toEqual([occurrence(1)]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not replace exact-equal occurrence snapshots", () => {
    const state = stores();
    const existing = [occurrence(2)];
    state.occurrences.set(path, existing);
    const listener = vi.fn();
    state.occurrences.subscribe(path, listener);

    const application = applyTargetApplyFileResult(
      file({
        fresh_file_metadata: fresh(2),
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

  it("transfers sole ownership of parsed occurrences without cloning", () => {
    const raw = file({ fresh_file_metadata: fresh(5) });
    const occurrences = raw.fresh_file_metadata!.occurrences;
    const prepared = prepareTargetApplyFileResult(raw);
    expect(prepared.occurrences).toBe(occurrences);
    expect(prepared).not.toHaveProperty("compatibility");
  });

  it("validates every batch file before mutating any store", () => {
    const state = stores();
    const firstPath = "first.jpg";
    state.occurrences.set(firstPath, [occurrence(9)]);
    const before = state.occurrences.get(firstPath);
    const validFirst = file({
      relative_path: firstPath,
      fresh_file_metadata: fresh(1, firstPath),
      target_outcomes: [],
      persisted_draft_entries: null,
    });
    const invalidSecond = {
      ...file({
        relative_path: "second.jpg",
        fresh_file_metadata: fresh(2, "second.jpg"),
        target_outcomes: [],
        persisted_draft_entries: null,
      }),
      fresh_file_metadata: {
        ...fresh(2, "second.jpg"),
        metadata: [],
      },
    };

    expect(() =>
      applyTargetApplyResult(
        batch([validFirst, invalidSecond as never]),
        state,
      ),
    ).toThrow(/fresh_file_metadata/);
    expect(state.occurrences.get(firstPath)).toBe(before);
  });

  it("preserves final cancelled and aborted result fields", () => {
    const state = stores();
    expect(
      applyTargetApplyResult(
        {
          summary: {
            requested: 0,
            selected: 0,
            completed: 0,
            applied: 0,
            failed: 0,
            warning_count: 0,
            cancelled: true,
            aborted: false,
            abort_reason: null,
            delivery_failure_count: 0,
          },
          undelivered_files: [],
          complete_delivery_failed: false,
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

  it("applies thousands of persisted draft rows with one store notification", () => {
    const state = stores();
    const count = 2_000;
    const paths = Array.from(
      { length: count },
      (_, index) => `file-${index}.jpg`,
    );
    state.drafts.resetMetadata(
      targetDraftsFromWire(
        Object.fromEntries(
          paths.map((relativePath) => [relativePath, [draft()]]),
        ),
      ),
    );
    const listener = vi.fn();
    state.drafts.subscribe(listener);

    const application = applyTargetApplyResult(
      batch(
        paths.map((relativePath) =>
          file({
            relative_path: relativePath,
            fresh_file_metadata: null,
            target_outcomes: [],
            persisted_draft_entries: [],
          }),
        ),
      ),
      state,
    );

    expect(application.files).toHaveLength(count);
    expect(Object.keys(state.drafts.getAllMetadata())).toHaveLength(0);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toHaveLength(count);
  });
});

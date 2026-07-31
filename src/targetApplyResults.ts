import {
  FileMetadataOccurrencesStore,
  type MetadataApplyFileResult,
  type MetadataOccurrences,
} from "./types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  type TargetDraftCollection,
} from "./targetDraftEdits";
import { metadataOccurrencesEqualExact } from "./utils/fileMetadataEquality";
import { recordFromEntries } from "./utils/stringRecord";
import {
  targetVerifyOutcomesFromBackend,
  validateTargetVerifyOutcomesAgainstDraftCollection,
  type TargetVerifyOutcome,
} from "./targetVerifyOutcomes";
import type { TargetVerifyOutcomesStore } from "./targetVerifyOutcomesStore";
import {
  targetApplyFileResultFromUnknown,
  targetApplyResultFromUnknown,
} from "./utils/targetApplyWire";

export interface TargetApplyResultStores {
  drafts: TargetDraftEditsStore;
  occurrences: FileMetadataOccurrencesStore;
  verification: TargetVerifyOutcomesStore;
}

export interface TargetApplyFileApplication {
  relativePath: string;
  draftsChanged: boolean;
  occurrencesChanged: boolean;
}

export interface TargetApplyResultApplication {
  files: TargetApplyFileApplication[];
  cancelled: boolean;
  aborted: boolean;
  abortReason: string | null;
}

export interface PreparedTargetApplyFileResult {
  readonly relativePath: string;
  readonly persistedDraftEntries: MetadataApplyFileResult["persisted_draft_entries"];
  readonly persistedDraftCollection: TargetDraftCollection | undefined | null;
  readonly occurrences: MetadataOccurrences | null;
  readonly targetVerifyOutcomes: TargetVerifyOutcome[];
}

function prepareValidatedTargetApplyFileResult(
  parsed: MetadataApplyFileResult,
): PreparedTargetApplyFileResult {
  const targetVerifyOutcomes = targetVerifyOutcomesFromBackend(
    parsed.relative_path,
    parsed.target_outcomes,
  );
  const persistedDraftEntries = parsed.persisted_draft_entries;
  let persistedDraftCollection: TargetDraftCollection | undefined | null = null;
  if (persistedDraftEntries !== null) {
    persistedDraftCollection = targetDraftsFromWire(
      recordFromEntries([[parsed.relative_path, persistedDraftEntries]]),
    )[parsed.relative_path];
  }

  return {
    relativePath: parsed.relative_path,
    persistedDraftEntries,
    persistedDraftCollection,
    occurrences:
      parsed.fresh_file_metadata === null
        ? null
        : parsed.fresh_file_metadata.occurrences,
    targetVerifyOutcomes,
  };
}

export function validatePreparedTargetApplyFileResult(
  prepared: PreparedTargetApplyFileResult,
  currentDrafts: TargetDraftCollection | undefined,
): void {
  validateTargetVerifyOutcomesAgainstDraftCollection(
    prepared.relativePath,
    prepared.targetVerifyOutcomes,
    prepared.persistedDraftEntries === null
      ? currentDrafts
      : (prepared.persistedDraftCollection ?? undefined),
  );
}

export function prepareTargetApplyFileResult(
  raw: unknown,
): PreparedTargetApplyFileResult {
  return prepareValidatedTargetApplyFileResult(
    targetApplyFileResultFromUnknown(raw),
  );
}

export function applyPreparedTargetApplyFileResult(
  prepared: PreparedTargetApplyFileResult,
  stores: TargetApplyResultStores,
): TargetApplyFileApplication {
  return applyPreparedTargetApplyFileResults([prepared], stores)[0];
}

export function applyPreparedTargetApplyFileResults(
  prepared: readonly PreparedTargetApplyFileResult[],
  stores: TargetApplyResultStores,
): TargetApplyFileApplication[] {
  for (const file of prepared) {
    validatePreparedTargetApplyFileResult(
      file,
      stores.drafts.getMetadataFile(file.relativePath),
    );
  }

  const draftChanged = new Set(
    stores.drafts.replaceMetadataFiles(
      prepared.flatMap((file) =>
        file.persistedDraftEntries === null
          ? []
          : [
              {
                path: file.relativePath,
                persistedEntries: file.persistedDraftEntries,
              },
            ],
      ),
    ),
  );
  stores.verification.replaceFiles(
    prepared.map((file) => ({
      path: file.relativePath,
      outcomes: file.targetVerifyOutcomes,
    })),
  );

  const occurrenceChanged = new Set(
    stores.occurrences.setMany(
      prepared.flatMap((file) => {
        if (file.occurrences === null) return [];
        const current = stores.occurrences.get(file.relativePath);
        return !Array.isArray(current) ||
          !metadataOccurrencesEqualExact(current, file.occurrences)
          ? [{ path: file.relativePath, value: file.occurrences }]
          : [];
      }),
    ),
  );

  return prepared.map((file) => ({
    relativePath: file.relativePath,
    draftsChanged: draftChanged.has(file.relativePath),
    occurrencesChanged: occurrenceChanged.has(file.relativePath),
  }));
}

export function applyTargetApplyFileResult(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyFileApplication {
  const prepared = prepareTargetApplyFileResult(raw);
  validatePreparedTargetApplyFileResult(
    prepared,
    stores.drafts.getMetadataFile(prepared.relativePath),
  );
  return applyPreparedTargetApplyFileResult(prepared, stores);
}

export function applyTargetApplyFileResults(
  raw: readonly unknown[],
  stores: TargetApplyResultStores,
): TargetApplyFileApplication[] {
  const prepared = raw.map((file) => prepareTargetApplyFileResult(file));
  return applyPreparedTargetApplyFileResults(prepared, stores);
}

export function applyTargetApplyResult(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyResultApplication {
  const parsed = targetApplyResultFromUnknown(raw);
  return {
    files: applyTargetApplyFileResults(parsed.undelivered_files, stores),
    cancelled: parsed.summary.cancelled,
    aborted: parsed.summary.aborted,
    abortReason: parsed.summary.abort_reason,
  };
}

import {
  FileMetadataOccurrencesStore,
  type MetadataApplyFileResult,
  type MetadataTargetOutcome,
  type MetadataOccurrences,
} from "./types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  type TargetDraftCollection,
  type TargetDraftEditsByFile,
} from "./targetDraftEdits";
import { metadataOccurrencesEqualExact } from "./utils/fileMetadataEquality";
import { recordFromEntries } from "./utils/stringRecord";
import {
  targetVerifyOutcomesFromBackend,
  validateTargetVerifyOutcomesAgainstDrafts,
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
  targetOutcomes: MetadataTargetOutcome[];
  targetVerifyOutcomes: TargetVerifyOutcome[];
  error: string | null;
  warning: string | null;
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
  readonly targetOutcomes: MetadataTargetOutcome[];
  readonly targetVerifyOutcomes: TargetVerifyOutcome[];
  readonly error: string | null;
  readonly warning: string | null;
}

function prepareValidatedTargetApplyFileResult(
  parsed: MetadataApplyFileResult,
): PreparedTargetApplyFileResult {
  const targetOutcomes = structuredClone(parsed.target_outcomes);
  const targetVerifyOutcomes = targetVerifyOutcomesFromBackend(
    parsed.relative_path,
    targetOutcomes,
  );
  const persistedDraftEntries =
    parsed.persisted_draft_entries === null
      ? null
      : structuredClone(parsed.persisted_draft_entries);
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
        : structuredClone(parsed.fresh_file_metadata.occurrences),
    targetOutcomes,
    targetVerifyOutcomes,
    error: parsed.error,
    warning: parsed.warning,
  };
}

export function validatePreparedTargetApplyFileResult(
  prepared: PreparedTargetApplyFileResult,
  currentDrafts: TargetDraftEditsByFile,
): void {
  let effectiveDrafts = currentDrafts;
  if (prepared.persistedDraftEntries !== null) {
    const retained = Object.entries(currentDrafts).filter(
      ([path]) => path !== prepared.relativePath,
    );
    effectiveDrafts = prepared.persistedDraftCollection
      ? recordFromEntries([
          ...retained,
          [prepared.relativePath, prepared.persistedDraftCollection] as const,
        ])
      : recordFromEntries(retained);
  }

  validateTargetVerifyOutcomesAgainstDrafts(
    prepared.relativePath,
    prepared.targetVerifyOutcomes,
    effectiveDrafts,
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
  const draftsChanged =
    prepared.persistedDraftEntries === null
      ? false
      : stores.drafts.replaceMetadataFile(
          prepared.relativePath,
          prepared.persistedDraftEntries,
        );

  stores.verification.replaceFile(
    prepared.relativePath,
    prepared.targetVerifyOutcomes,
  );

  let occurrencesChanged = false;
  if (prepared.occurrences !== null) {
    const currentOccurrences = stores.occurrences.get(prepared.relativePath);
    occurrencesChanged =
      !Array.isArray(currentOccurrences) ||
      !metadataOccurrencesEqualExact(currentOccurrences, prepared.occurrences);
    if (occurrencesChanged) {
      stores.occurrences.set(prepared.relativePath, prepared.occurrences);
    }
  }

  return {
    relativePath: prepared.relativePath,
    draftsChanged,
    occurrencesChanged,
    targetOutcomes: structuredClone(prepared.targetOutcomes),
    targetVerifyOutcomes: structuredClone(prepared.targetVerifyOutcomes),
    error: prepared.error,
    warning: prepared.warning,
  };
}

export function applyTargetApplyFileResult(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyFileApplication {
  const prepared = prepareTargetApplyFileResult(raw);
  validatePreparedTargetApplyFileResult(
    prepared,
    stores.drafts.getAllMetadata(),
  );
  return applyPreparedTargetApplyFileResult(prepared, stores);
}

export function applyTargetApplyResult(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyResultApplication {
  const parsed = targetApplyResultFromUnknown(raw);
  const prepared = parsed.files.map(prepareValidatedTargetApplyFileResult);
  const currentDrafts = stores.drafts.getAllMetadata();
  for (const file of prepared) {
    validatePreparedTargetApplyFileResult(file, currentDrafts);
  }
  return {
    files: prepared.map((file) =>
      applyPreparedTargetApplyFileResult(file, stores),
    ),
    cancelled: parsed.cancelled,
    aborted: parsed.aborted,
    abortReason: parsed.abort_reason,
  };
}

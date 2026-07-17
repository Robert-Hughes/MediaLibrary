import {
  ImageMetadataOccurrencesStore,
  type MetadataApplyFileResultV5,
  type MetadataTargetOutcome,
  type MetadataOccurrences,
} from "./types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  type TargetDraftCollection,
  type TargetDraftEditsByFile,
} from "./targetDraftEdits";
import { metadataOccurrencesEqualExact } from "./utils/imageMetadataEquality";
import { recordFromEntries } from "./utils/stringRecord";
import {
  targetVerifyOutcomesFromBackend,
  validateTargetVerifyOutcomesAgainstDrafts,
  type TargetVerifyOutcomeV5,
} from "./targetVerifyOutcomes";
import type { TargetVerifyOutcomesStoreV5 } from "./targetVerifyOutcomesStore";
import {
  targetApplyFileResultFromUnknown,
  targetApplyResultFromUnknown,
} from "./utils/targetApplyWire";

export interface TargetApplyResultStores {
  drafts: TargetDraftEditsStore;
  occurrences: ImageMetadataOccurrencesStore;
  verification: TargetVerifyOutcomesStoreV5;
}

export interface TargetApplyFileApplicationV5 {
  relativePath: string;
  draftsChanged: boolean;
  occurrencesChanged: boolean;
  targetOutcomes: MetadataTargetOutcome[];
  targetVerifyOutcomes: TargetVerifyOutcomeV5[];
  error: string | null;
  warning: string | null;
}

export interface TargetApplyResultApplicationV5 {
  files: TargetApplyFileApplicationV5[];
  cancelled: boolean;
  aborted: boolean;
  abortReason: string | null;
}

export interface PreparedTargetApplyFileResultV5 {
  readonly relativePath: string;
  readonly persistedDraftEntries: MetadataApplyFileResultV5["persisted_draft_entries"];
  readonly persistedDraftCollection: TargetDraftCollection | undefined | null;
  readonly occurrences: MetadataOccurrences | null;
  readonly targetOutcomes: MetadataTargetOutcome[];
  readonly targetVerifyOutcomes: TargetVerifyOutcomeV5[];
  readonly error: string | null;
  readonly warning: string | null;
}

function prepareValidatedTargetApplyFileResultV5(
  parsed: MetadataApplyFileResultV5,
): PreparedTargetApplyFileResultV5 {
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
      parsed.fresh_image_metadata === null
        ? null
        : structuredClone(parsed.fresh_image_metadata.occurrences),
    targetOutcomes,
    targetVerifyOutcomes,
    error: parsed.error,
    warning: parsed.warning,
  };
}

export function validatePreparedTargetApplyFileResultV5(
  prepared: PreparedTargetApplyFileResultV5,
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

export function prepareTargetApplyFileResultV5(
  raw: unknown,
): PreparedTargetApplyFileResultV5 {
  return prepareValidatedTargetApplyFileResultV5(
    targetApplyFileResultFromUnknown(raw),
  );
}

export function applyPreparedTargetApplyFileResultV5(
  prepared: PreparedTargetApplyFileResultV5,
  stores: TargetApplyResultStores,
): TargetApplyFileApplicationV5 {
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
      currentOccurrences === "loading" ||
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

export function applyTargetApplyFileResultV5(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyFileApplicationV5 {
  const prepared = prepareTargetApplyFileResultV5(raw);
  validatePreparedTargetApplyFileResultV5(
    prepared,
    stores.drafts.getAllMetadata(),
  );
  return applyPreparedTargetApplyFileResultV5(prepared, stores);
}

export function applyTargetApplyResultV5(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyResultApplicationV5 {
  const parsed = targetApplyResultFromUnknown(raw);
  const prepared = parsed.files.map(prepareValidatedTargetApplyFileResultV5);
  const currentDrafts = stores.drafts.getAllMetadata();
  for (const file of prepared) {
    validatePreparedTargetApplyFileResultV5(file, currentDrafts);
  }
  return {
    files: prepared.map((file) =>
      applyPreparedTargetApplyFileResultV5(file, stores),
    ),
    cancelled: parsed.cancelled,
    aborted: parsed.aborted,
    abortReason: parsed.abort_reason,
  };
}

import {
  ImageMetadataOccurrencesStore,
  ImageMetadataStore,
  type MetadataApplyFileResultV5,
  type MetadataTargetOutcome,
  type MetadataOccurrences,
} from "./types";
import {
  TargetDraftEditsStore,
  targetDraftsFromWire,
  type TargetDraftCollection,
} from "./targetDraftEdits";
import {
  metadataCollection,
  type MetadataCollection,
} from "./utils/metadataCollection";
import {
  metadataCollectionsEqualExact,
  metadataOccurrencesEqualExact,
} from "./utils/imageMetadataEquality";
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
  compatibility: ImageMetadataStore;
  verification: TargetVerifyOutcomesStoreV5;
}

export interface TargetApplyFileApplicationV5 {
  relativePath: string;
  draftsChanged: boolean;
  occurrencesChanged: boolean;
  compatibilityChanged: boolean;
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
  readonly compatibility: MetadataCollection | null;
  readonly targetOutcomes: MetadataTargetOutcome[];
  readonly error: string | null;
  readonly warning: string | null;
}

function prepareValidatedTargetApplyFileResultV5(
  parsed: MetadataApplyFileResultV5,
): PreparedTargetApplyFileResultV5 {
  const targetOutcomes = structuredClone(parsed.target_outcomes);
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

  if (parsed.fresh_image_metadata === null) {
    return {
      relativePath: parsed.relative_path,
      persistedDraftEntries,
      persistedDraftCollection,
      occurrences: null,
      compatibility: null,
      targetOutcomes,
      error: parsed.error,
      warning: parsed.warning,
    };
  }

  const fresh = structuredClone(parsed.fresh_image_metadata);
  return {
    relativePath: parsed.relative_path,
    persistedDraftEntries,
    persistedDraftCollection,
    occurrences: fresh.occurrences,
    compatibility: metadataCollection(fresh.metadata),
    targetOutcomes,
    error: parsed.error,
    warning: parsed.warning,
  };
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

  const targetOutcomes = targetVerifyOutcomesFromBackend(
    prepared.relativePath,
    prepared.targetOutcomes,
  );
  try {
    validateTargetVerifyOutcomesAgainstDrafts(
      prepared.relativePath,
      targetOutcomes,
      stores.drafts.getAllMetadata(),
    );
  } catch (error) {
    stores.verification.deletePath(prepared.relativePath);
    throw error;
  }
  stores.verification.replaceFile(prepared.relativePath, targetOutcomes);

  let occurrencesChanged = false;
  let compatibilityChanged = false;
  if (prepared.occurrences !== null && prepared.compatibility !== null) {
    const currentOccurrences = stores.occurrences.get(prepared.relativePath);
    occurrencesChanged =
      currentOccurrences === "loading" ||
      !metadataOccurrencesEqualExact(currentOccurrences, prepared.occurrences);
    if (occurrencesChanged) {
      stores.occurrences.set(prepared.relativePath, prepared.occurrences);
    }

    const currentCompatibility = stores.compatibility.get(
      prepared.relativePath,
    );
    compatibilityChanged =
      currentCompatibility === "loading" ||
      !metadataCollectionsEqualExact(
        currentCompatibility,
        prepared.compatibility,
      );
    if (compatibilityChanged) {
      stores.compatibility.set(prepared.relativePath, prepared.compatibility);
    }
  }

  return {
    relativePath: prepared.relativePath,
    draftsChanged,
    occurrencesChanged,
    compatibilityChanged,
    targetOutcomes: structuredClone(prepared.targetOutcomes),
    targetVerifyOutcomes: targetOutcomes,
    error: prepared.error,
    warning: prepared.warning,
  };
}

export function applyTargetApplyFileResultV5(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyFileApplicationV5 {
  return applyPreparedTargetApplyFileResultV5(
    prepareTargetApplyFileResultV5(raw),
    stores,
  );
}

export function applyTargetApplyResultV5(
  raw: unknown,
  stores: TargetApplyResultStores,
): TargetApplyResultApplicationV5 {
  const parsed = targetApplyResultFromUnknown(raw);
  const prepared = parsed.files.map(prepareValidatedTargetApplyFileResultV5);
  return {
    files: prepared.map((file) =>
      applyPreparedTargetApplyFileResultV5(file, stores),
    ),
    cancelled: parsed.cancelled,
    aborted: parsed.aborted,
    abortReason: parsed.abort_reason,
  };
}

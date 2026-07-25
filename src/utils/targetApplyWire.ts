import type {
  MetadataApplyStartedPayload,
  MetadataApplyProgressPayload,
  MetadataApplyResult,
  MetadataApplyFileResult,
  MetadataTargetDraftEntry,
  MetadataTargetOutcome,
} from "../types";
import { targetDraftsFromWire } from "../targetDraftEdits";
import { metadataDraftTargetSlotToken } from "./metadataDraftTarget";
import {
  findFileMetadataDuplicateIdentity,
  isFileMetadata,
  isMetadataTargetDraftEntry,
  isMetadataTargetOutcome,
  isRecord,
} from "./metadataWireGuards";

function invalid(context: string, detail: string): never {
  throw new Error(`${context}: ${detail}`);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value >= 0;
}

export function targetApplyFileResultFromUnknown(
  raw: unknown,
  context = "Invalid target-aware apply file result",
): MetadataApplyFileResult {
  if (!isRecord(raw)) invalid(context, "expected an object");

  const relativePath = raw.relative_path;
  if (typeof relativePath !== "string") {
    invalid(context, "relative_path must be a string");
  }
  if (typeof raw.applied !== "boolean") {
    invalid(`${context} for '${relativePath}'`, "applied must be a boolean");
  }
  const applied = raw.applied;
  if (!(raw.error === null || typeof raw.error === "string")) {
    invalid(
      `${context} for '${relativePath}'`,
      "error must be null or a string",
    );
  }
  const error = raw.error;
  if (applied !== (error === null)) {
    invalid(
      `${context} for '${relativePath}'`,
      "applied must be true exactly when error is null",
    );
  }
  if (!(raw.warning === null || typeof raw.warning === "string")) {
    invalid(
      `${context} for '${relativePath}'`,
      "warning must be null or a string",
    );
  }
  const warning = raw.warning;

  const fresh = raw.fresh_file_metadata;
  const duplicateIdentity = findFileMetadataDuplicateIdentity(fresh);
  if (duplicateIdentity) {
    invalid(
      `${context} for '${relativePath}'`,
      `fresh_file_metadata contains duplicate ${duplicateIdentity.kind} ID '${duplicateIdentity.token}' at indexes ${duplicateIdentity.firstIndex} and ${duplicateIdentity.secondIndex}`,
    );
  }
  if (!(fresh === null || isFileMetadata(fresh))) {
    invalid(
      `${context} for '${relativePath}'`,
      "fresh_file_metadata must be null or complete valid FileMetadata",
    );
  }
  if (fresh !== null && fresh.relative_path !== relativePath) {
    invalid(
      `${context} for '${relativePath}'`,
      `fresh_file_metadata path '${fresh.relative_path}' does not match result path`,
    );
  }

  const outcomes = raw.target_outcomes;
  if (!Array.isArray(outcomes)) {
    invalid(
      `${context} for '${relativePath}'`,
      "target_outcomes must be an array",
    );
  }
  const typedOutcomes: MetadataTargetOutcome[] = [];
  const outcomeSlots = new Map<
    string,
    { index: number; target: MetadataTargetOutcome["target"] }
  >();
  for (const [index, outcome] of outcomes.entries()) {
    if (!isMetadataTargetOutcome(outcome)) {
      invalid(
        `${context} for '${relativePath}'`,
        `target_outcomes[${index}] is invalid`,
      );
    }
    const slot = metadataDraftTargetSlotToken(outcome.target);
    const previous = outcomeSlots.get(slot);
    if (previous) {
      invalid(
        `${context} for '${relativePath}'`,
        `duplicate target outcome slot '${slot}': target_outcomes[${previous.index}] ${JSON.stringify(previous.target)} and target_outcomes[${index}] ${JSON.stringify(outcome.target)}`,
      );
    }
    outcomeSlots.set(slot, { index, target: outcome.target });
    typedOutcomes.push(outcome);
  }

  const persisted = raw.persisted_draft_entries;
  let typedPersisted: MetadataTargetDraftEntry[] | null;
  if (persisted === null) {
    typedPersisted = null;
  } else {
    if (!Array.isArray(persisted)) {
      invalid(
        `${context} for '${relativePath}'`,
        "persisted_draft_entries must be null or an array",
      );
    }
    typedPersisted = [];
    for (const [index, entry] of persisted.entries()) {
      if (!isMetadataTargetDraftEntry(entry)) {
        invalid(
          `${context} for '${relativePath}'`,
          `persisted_draft_entries[${index}] is invalid`,
        );
      }
      typedPersisted.push(entry);
    }
    // Reuse the strict target-draft collection conversion for logical-slot
    // duplicate detection, but retain the authoritative array unchanged.
    targetDraftsFromWire({ [relativePath]: typedPersisted });
  }

  return {
    relative_path: relativePath,
    applied,
    error,
    warning,
    fresh_file_metadata: fresh,
    target_outcomes: typedOutcomes,
    persisted_draft_entries: typedPersisted,
  };
}

export function targetApplyResultFromUnknown(
  raw: unknown,
): MetadataApplyResult {
  const context = "Invalid target-aware apply result";
  if (!isRecord(raw)) invalid(context, "expected an object");
  if (!Array.isArray(raw.files)) invalid(context, "files must be an array");
  if (typeof raw.cancelled !== "boolean") {
    invalid(context, "cancelled must be a boolean");
  }
  if (typeof raw.aborted !== "boolean") {
    invalid(context, "aborted must be a boolean");
  }
  if (!(raw.abort_reason === null || typeof raw.abort_reason === "string")) {
    invalid(context, "abort_reason must be null or a string");
  }
  if (raw.cancelled && raw.aborted) {
    invalid(context, "cancelled and aborted cannot both be true");
  }
  if (raw.aborted !== (raw.abort_reason !== null)) {
    invalid(
      context,
      "aborted must be true exactly when abort_reason is non-null",
    );
  }

  const files: MetadataApplyFileResult[] = [];
  const paths = new Set<string>();
  for (const [index, file] of raw.files.entries()) {
    const parsed = targetApplyFileResultFromUnknown(
      file,
      `${context} files[${index}]`,
    );
    if (paths.has(parsed.relative_path)) {
      invalid(
        context,
        `duplicate file relative_path '${parsed.relative_path}'`,
      );
    }
    paths.add(parsed.relative_path);
    files.push(parsed);
  }

  return {
    files,
    cancelled: raw.cancelled,
    aborted: raw.aborted,
    abort_reason: raw.abort_reason,
  };
}

export function targetApplyStartedFromUnknown(
  raw: unknown,
): MetadataApplyStartedPayload {
  const context = "Invalid apply_edits_started payload";
  if (!isRecord(raw)) invalid(context, "expected an object");
  if (!isNonNegativeSafeInteger(raw.total)) {
    invalid(context, "total must be a non-negative safe integer");
  }
  return { total: raw.total };
}

export function targetApplyProgressFromUnknown(
  raw: unknown,
): MetadataApplyProgressPayload {
  const context = "Invalid apply_metadata_edits_progress payload";
  if (!isRecord(raw)) invalid(context, "expected an object");
  if (!isNonNegativeSafeInteger(raw.total) || raw.total < 1) {
    invalid(context, "total must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(raw.current) || raw.current < 1) {
    invalid(context, "current must be a positive safe integer");
  }
  if (raw.current > raw.total) {
    invalid(context, "current cannot exceed total");
  }
  return {
    current: raw.current,
    total: raw.total,
    result: targetApplyFileResultFromUnknown(raw.result, `${context} result`),
  };
}

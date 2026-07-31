import type {
  MetadataApplyFileResult,
  MetadataApplyResult,
  MetadataApplyStreamMessage,
  MetadataApplySummary,
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

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
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

export function targetApplySummaryFromUnknown(
  raw: unknown,
  context = "Invalid target-aware apply summary",
): MetadataApplySummary {
  if (!isRecord(raw)) invalid(context, "expected an object");
  const integerFields = [
    "requested",
    "selected",
    "completed",
    "applied",
    "failed",
    "warning_count",
    "delivery_failure_count",
  ] as const;
  for (const field of integerFields) {
    if (!isNonNegativeSafeInteger(raw[field])) {
      invalid(context, `${field} must be a non-negative safe integer`);
    }
  }
  const requested = raw.requested as number;
  const selected = raw.selected as number;
  const completed = raw.completed as number;
  const applied = raw.applied as number;
  const failed = raw.failed as number;
  const warningCount = raw.warning_count as number;
  const deliveryFailureCount = raw.delivery_failure_count as number;
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
  if (selected > requested) {
    invalid(context, "selected cannot exceed requested");
  }
  if (completed > selected) {
    invalid(context, "completed cannot exceed selected");
  }
  if (applied + failed !== completed) {
    invalid(context, "applied plus failed must equal completed");
  }
  if (warningCount > completed) {
    invalid(context, "warning_count cannot exceed completed");
  }
  if (deliveryFailureCount > completed) {
    invalid(context, "delivery_failure_count cannot exceed completed");
  }

  return {
    requested,
    selected,
    completed,
    applied,
    failed,
    warning_count: warningCount,
    cancelled: raw.cancelled,
    aborted: raw.aborted,
    abort_reason: raw.abort_reason,
    delivery_failure_count: deliveryFailureCount,
  };
}

function targetApplyFilesFromUnknown(
  raw: unknown,
  context: string,
): MetadataApplyFileResult[] {
  if (!Array.isArray(raw)) invalid(context, "expected an array");
  const files: MetadataApplyFileResult[] = [];
  const paths = new Set<string>();
  for (const [index, file] of raw.entries()) {
    const parsed = targetApplyFileResultFromUnknown(
      file,
      `${context}[${index}]`,
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
  return files;
}

export function targetApplyResultFromUnknown(
  raw: unknown,
): MetadataApplyResult {
  const context = "Invalid target-aware apply result";
  if (!isRecord(raw)) invalid(context, "expected an object");
  const summary = targetApplySummaryFromUnknown(
    raw.summary,
    `${context} summary`,
  );
  const undeliveredFiles = targetApplyFilesFromUnknown(
    raw.undelivered_files,
    `${context} undelivered_files`,
  );
  if (undeliveredFiles.length !== summary.delivery_failure_count) {
    invalid(
      context,
      "undelivered_files length must equal summary.delivery_failure_count",
    );
  }
  if (typeof raw.complete_delivery_failed !== "boolean") {
    invalid(context, "complete_delivery_failed must be a boolean");
  }
  return {
    summary,
    undelivered_files: undeliveredFiles,
    complete_delivery_failed: raw.complete_delivery_failed,
  };
}

/**
 * Returns null for a well-formed message owned by a different operation.
 * Operation identity is checked before parsing any heavyweight file results.
 */
export function targetApplyStreamMessageFromUnknown(
  raw: unknown,
  expectedOperationId: string,
): MetadataApplyStreamMessage | null {
  const context = "Invalid target-aware apply stream message";
  if (!isRecord(raw)) invalid(context, "expected an object");
  if (typeof raw.operation_id !== "string") {
    invalid(context, "operation_id must be a string");
  }
  if (raw.operation_id !== expectedOperationId) return null;
  if (typeof raw.kind !== "string") invalid(context, "kind must be a string");

  if (raw.kind === "started") {
    if (!isNonNegativeSafeInteger(raw.total)) {
      invalid(context, "started total must be a non-negative safe integer");
    }
    return {
      kind: "started",
      operation_id: raw.operation_id,
      total: raw.total,
    };
  }

  if (raw.kind === "progress_batch") {
    if (!isPositiveSafeInteger(raw.sequence)) {
      invalid(context, "progress sequence must be a positive safe integer");
    }
    if (!isPositiveSafeInteger(raw.current)) {
      invalid(context, "progress current must be a positive safe integer");
    }
    if (!isPositiveSafeInteger(raw.total)) {
      invalid(context, "progress total must be a positive safe integer");
    }
    if (raw.current > raw.total) {
      invalid(context, "progress current cannot exceed total");
    }
    const results = targetApplyFilesFromUnknown(
      raw.results,
      `${context} results`,
    );
    if (results.length === 0) {
      invalid(context, "progress results must not be empty");
    }
    if (results.length > raw.current) {
      invalid(context, "progress results cannot exceed current");
    }
    return {
      kind: "progress_batch",
      operation_id: raw.operation_id,
      sequence: raw.sequence,
      current: raw.current,
      total: raw.total,
      results,
    };
  }

  if (raw.kind === "complete") {
    return {
      kind: "complete",
      operation_id: raw.operation_id,
      summary: targetApplySummaryFromUnknown(raw.summary, `${context} summary`),
    };
  }

  return invalid(context, `unsupported kind '${raw.kind}'`);
}

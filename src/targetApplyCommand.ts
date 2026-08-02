import type {
  MetadataApplyFileResult,
  MetadataApplyResult,
  MetadataApplyStreamMessage,
  MetadataApplySummary,
} from "./types";
import {
  applyTargetDraftEdits,
  type TargetApplyTauriApi,
} from "./targetApplyTauri";

export interface TargetApplyCommandCallbacks {
  onProtocolError?: (error: Error) => void;
  onMessageError?: (error: Error) => void;
  onFileError?: (relativePath: string, error: string) => void;
  onFileWarning?: (relativePath: string, warning: string) => void;
}

let nextOperationId = 0;

function summariesEqual(
  left: MetadataApplySummary,
  right: MetadataApplySummary,
): boolean {
  return (
    left.requested === right.requested &&
    left.selected === right.selected &&
    left.completed === right.completed &&
    left.applied === right.applied &&
    left.failed === right.failed &&
    left.warning_count === right.warning_count &&
    left.cancelled === right.cancelled &&
    left.aborted === right.aborted &&
    left.abort_reason === right.abort_reason &&
    left.delivery_failure_count === right.delivery_failure_count
  );
}

function reportSafely(callback: (() => void) | undefined): void {
  if (!callback) return;
  try {
    callback();
  } catch (error) {
    console.error(
      "[metadata] Target-aware apply diagnostic callback failed",
      error,
    );
  }
}

function presentDiagnostics(
  results: readonly MetadataApplyFileResult[],
  callbacks: TargetApplyCommandCallbacks,
): void {
  for (const result of results) {
    if (result.error !== null) {
      reportSafely(() =>
        callbacks.onFileError?.(result.relative_path, result.error!),
      );
    }
    if (result.warning !== null) {
      reportSafely(() =>
        callbacks.onFileWarning?.(result.relative_path, result.warning!),
      );
    }
  }
}

/**
 * Dispatch one Rust-owned Apply operation while validating its command-scoped
 * diagnostic stream. Operation progress and completion remain authoritative in
 * the media-library session snapshot; this function owns no durable UI state.
 */
export async function runTargetApplyCommand(
  api: TargetApplyTauriApi,
  folderPath: string,
  relativePaths: readonly string[] | undefined,
  callbacks: TargetApplyCommandCallbacks = {},
): Promise<MetadataApplyResult> {
  const operationId = `target-apply-${++nextOperationId}`;
  let streamTotal: number | null = null;
  let streamCurrent = 0;
  let lastSequence = 0;
  let streamSummary: MetadataApplySummary | null = null;

  const protocolError = (error: Error) => {
    reportSafely(() => callbacks.onProtocolError?.(error));
  };

  const onMessage = (message: MetadataApplyStreamMessage) => {
    if (message.kind === "started") {
      if (streamTotal !== null) {
        protocolError(new Error("Duplicate Apply started message"));
        return;
      }
      streamTotal = message.total;
      return;
    }
    if (message.kind === "complete") {
      streamSummary = message.summary;
      return;
    }
    if (streamTotal === null) {
      protocolError(
        new Error("Apply progress arrived before the started message"),
      );
      return;
    }
    if (message.total !== streamTotal) {
      protocolError(new Error("Apply progress total changed"));
      return;
    }
    if (message.sequence !== lastSequence + 1) {
      protocolError(new Error("Apply progress sequence is not contiguous"));
      return;
    }
    if (message.current !== streamCurrent + message.results.length) {
      protocolError(new Error("Apply progress current is not contiguous"));
      return;
    }
    lastSequence = message.sequence;
    streamCurrent = message.current;
    presentDiagnostics(message.results, callbacks);
  };

  const result = await applyTargetDraftEdits(
    api,
    folderPath,
    relativePaths,
    operationId,
    {
      onMessage,
      onProtocolError: protocolError,
      onMessageError: (error) =>
        reportSafely(() => callbacks.onMessageError?.(error)),
    },
  );

  const completedSummary = streamSummary as MetadataApplySummary | null;
  if (
    completedSummary !== null &&
    !summariesEqual(completedSummary, result.summary)
  ) {
    protocolError(
      new Error("Stream completion summary differs from command result"),
    );
  }
  if (
    streamCurrent + result.summary.delivery_failure_count !==
    result.summary.completed
  ) {
    protocolError(
      new Error("Stream and undelivered counts do not cover completed files"),
    );
  }

  presentDiagnostics(result.undelivered_files, callbacks);
  return { ...result, undelivered_files: [] };
}

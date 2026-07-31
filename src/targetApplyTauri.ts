import type { MetadataApplyResult, MetadataApplyStreamMessage } from "./types";
import {
  targetApplyResultFromUnknown,
  targetApplyStreamMessageFromUnknown,
} from "./utils/targetApplyWire";

export interface TargetApplyChannel {
  onmessage: (payload: unknown) => void;
}

export interface TargetApplyTauriApi {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  createChannel(handler: (payload: unknown) => void): TargetApplyChannel;
}

export interface TargetApplyStreamHandlers {
  onMessage?: (message: MetadataApplyStreamMessage) => void;
  onProtocolError?: (error: Error) => void;
  onMessageError?: (error: Error, message: MetadataApplyStreamMessage) => void;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reportProtocolError(
  handlers: TargetApplyStreamHandlers,
  error: Error,
  rawPayload: unknown,
): void {
  if (!handlers.onProtocolError) {
    console.error(
      "[metadata] Invalid target-aware apply stream payload",
      error,
      rawPayload,
    );
    return;
  }
  try {
    handlers.onProtocolError(error);
  } catch (reportingError) {
    console.error(
      "[metadata] Target-aware apply protocol-error handler failed",
      reportingError,
    );
  }
}

function isExpectedComplete(raw: unknown, operationId: string): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).kind === "complete" &&
    (raw as Record<string, unknown>).operation_id === operationId
  );
}

/**
 * Invoke one target-aware Apply with a command-owned ordered channel.
 * The normal terminal response is compact; only failed channel deliveries are
 * returned as full per-file fallback payloads.
 */
export async function applyTargetDraftEdits(
  api: TargetApplyTauriApi,
  folderPath: string,
  relativePaths: readonly string[] | undefined,
  operationId: string,
  handlers: TargetApplyStreamHandlers,
): Promise<MetadataApplyResult> {
  if (relativePaths !== undefined) {
    const seen = new Set<string>();
    for (const path of relativePaths) {
      if (seen.has(path)) {
        throw new Error(`Duplicate target-aware apply relative path '${path}'`);
      }
      seen.add(path);
    }
  }

  let active = true;
  let completeSeen = false;
  let resolveComplete!: () => void;
  const complete = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const channel = api.createChannel((rawPayload) => {
    if (!active) return;
    const completesOperation = isExpectedComplete(rawPayload, operationId);
    try {
      const message = targetApplyStreamMessageFromUnknown(
        rawPayload,
        operationId,
      );
      if (message === null) return;
      try {
        handlers.onMessage?.(message);
      } catch (error) {
        const typed = asError(error);
        if (handlers.onMessageError) {
          try {
            handlers.onMessageError(typed, message);
          } catch (reportingError) {
            console.error(
              "[metadata] Target-aware apply message-error handler failed",
              reportingError,
            );
          }
        } else {
          console.error(
            "[metadata] Target-aware apply channel handler failed",
            typed,
          );
        }
      }
    } catch (error) {
      reportProtocolError(handlers, asError(error), rawPayload);
    } finally {
      if (completesOperation && !completeSeen) {
        completeSeen = true;
        resolveComplete();
      }
    }
  });

  try {
    const raw = await api.invoke("apply_metadata_draft_edits_cmd", {
      folderPath,
      relPaths: relativePaths === undefined ? null : Array.from(relativePaths),
      operationId,
      progressChannel: channel,
    });
    const result = targetApplyResultFromUnknown(raw);
    if (!result.complete_delivery_failed && !completeSeen) {
      await complete;
    }
    return result;
  } finally {
    active = false;
    channel.onmessage = () => undefined;
  }
}

export async function cancelTargetApply(
  api: Pick<TargetApplyTauriApi, "invoke">,
): Promise<void> {
  await api.invoke("cancel_apply_edits");
}

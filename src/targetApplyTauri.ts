import type {
  MetadataApplyStartedPayload,
  MetadataApplyProgressPayload,
  MetadataApplyResult,
} from "./types";
import {
  targetApplyProgressFromUnknown,
  targetApplyResultFromUnknown,
  targetApplyStartedFromUnknown,
} from "./utils/targetApplyWire";

export interface TargetApplyTauriApi {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(
    event: string,
    handler: (payload: unknown) => void,
  ): Promise<() => void>;
}

export async function applyTargetDraftEdits(
  api: Pick<TargetApplyTauriApi, "invoke">,
  folderPath: string,
  relativePaths: string[],
): Promise<MetadataApplyResult> {
  const seen = new Set<string>();
  for (const path of relativePaths) {
    if (seen.has(path)) {
      throw new Error(`Duplicate target-aware apply relative path '${path}'`);
    }
    seen.add(path);
  }

  const raw = await api.invoke("apply_metadata_draft_edits_cmd", {
    folderPath,
    relPaths: relativePaths.slice(),
  });
  return targetApplyResultFromUnknown(raw);
}

export async function cancelTargetApply(
  api: Pick<TargetApplyTauriApi, "invoke">,
): Promise<void> {
  await api.invoke("cancel_apply_edits");
}

export interface TargetApplyEventHandlers {
  onStarted?: (payload: MetadataApplyStartedPayload) => void;
  onProgress?: (payload: MetadataApplyProgressPayload) => void;
  onProtocolError?: (
    error: Error,
    eventName: string,
    rawPayload: unknown,
  ) => void;
}

function reportProtocolError(
  handlers: TargetApplyEventHandlers,
  error: Error,
  eventName: string,
  rawPayload: unknown,
): void {
  if (!handlers.onProtocolError) {
    console.error(`[metadata] Invalid ${eventName} payload`, error, rawPayload);
    return;
  }
  try {
    handlers.onProtocolError(error, eventName, rawPayload);
  } catch (reportingError) {
    console.error(
      `[metadata] Protocol-error handler failed for ${eventName}`,
      reportingError,
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Versioned progress events provide optional immediate updates. The final
 * command result is authoritative for completed files and batch status because
 * backend event emission failures are deliberately non-fatal.
 *
 * Registration stays separate from invocation: these global events describe
 * the sole active target-aware apply operation and do not carry an operation ID.
 */
export async function subscribeTargetApplyEvents(
  api: Pick<TargetApplyTauriApi, "listen">,
  handlers: TargetApplyEventHandlers,
): Promise<() => void> {
  const startedEvent = "apply_edits_started";
  const progressEvent = "apply_metadata_edits_progress";

  const unregisterStarted = await api.listen(startedEvent, (rawPayload) => {
    let payload: MetadataApplyStartedPayload;
    try {
      payload = targetApplyStartedFromUnknown(rawPayload);
    } catch (error) {
      reportProtocolError(handlers, asError(error), startedEvent, rawPayload);
      return;
    }
    handlers.onStarted?.(payload);
  });

  let unregisterProgress: () => void;
  try {
    unregisterProgress = await api.listen(progressEvent, (rawPayload) => {
      let payload: MetadataApplyProgressPayload;
      try {
        payload = targetApplyProgressFromUnknown(rawPayload);
      } catch (error) {
        reportProtocolError(
          handlers,
          asError(error),
          progressEvent,
          rawPayload,
        );
        return;
      }
      handlers.onProgress?.(payload);
    });
  } catch (registrationError) {
    try {
      unregisterStarted();
    } catch (cleanupError) {
      console.error(
        `[metadata] Failed to unregister ${startedEvent} after listener setup failure`,
        cleanupError,
      );
    }
    throw registrationError;
  }

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    let firstError: unknown;
    try {
      unregisterStarted();
    } catch (error) {
      firstError = error;
    }
    try {
      unregisterProgress();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError !== undefined) throw firstError;
  };
}

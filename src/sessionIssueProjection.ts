import type {
  ApplicationErrorPayload,
  MediaLibrarySessionIssue,
} from "./types";
import { MAX_APPLICATION_ERRORS } from "./utils/scanEvents";

export function projectSessionIssues(
  sessionId: number,
  issues: readonly MediaLibrarySessionIssue[],
): ApplicationErrorPayload[] {
  return issues.map((issue) => ({
    ...issue,
    severity: issue.severity === "warning" ? "warning" : "error",
    scan_id: sessionId,
  }));
}

export function mergeSessionIssues(
  _current: readonly ApplicationErrorPayload[],
  sessionId: number,
  issues: readonly MediaLibrarySessionIssue[],
): ApplicationErrorPayload[] {
  return projectSessionIssues(sessionId, issues).slice(-MAX_APPLICATION_ERRORS);
}

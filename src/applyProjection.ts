import type {
  ApplyEditsCompletion,
  ApplyEditsInFlight,
  MediaLibraryApplyOperation,
  MetadataApplyResult,
} from "./types";

export function emptyMetadataApplyResult(): MetadataApplyResult {
  return {
    summary: {
      requested: 0,
      selected: 0,
      completed: 0,
      applied: 0,
      failed: 0,
      warning_count: 0,
      cancelled: false,
      aborted: false,
      abort_reason: null,
      delivery_failure_count: 0,
    },
    undelivered_files: [],
    complete_delivery_failed: false,
  };
}

export function projectApplyOperation(
  operation: MediaLibraryApplyOperation | null,
): {
  applying: ApplyEditsInFlight | null;
  completion: ApplyEditsCompletion | null;
} {
  if (operation === null) return { applying: null, completion: null };
  if (operation.state.status === "running") {
    return {
      applying: {
        total: operation.total ?? 0,
        current: operation.current,
        currentFile: operation.current_file,
        failureCount: operation.file_failure_count,
        cancelling: operation.cancelling,
      },
      completion: null,
    };
  }
  if (operation.state.status === "completed" && operation.summary !== null) {
    return {
      applying: null,
      completion: {
        summary: operation.summary,
        issues: operation.issues.map((issue) => ({
          relativePath: issue.relative_path,
          severity: issue.severity === "warning" ? "warning" : "error",
          message: issue.message,
        })),
      },
    };
  }
  return { applying: null, completion: null };
}

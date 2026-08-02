import { describe, expect, it } from "vitest";
import {
  mergeSessionIssues,
  projectSessionIssues,
} from "../sessionIssueProjection";
import type {
  ApplicationErrorPayload,
  MediaLibrarySessionIssue,
} from "../types";

const backendIssue: MediaLibrarySessionIssue = {
  issue_id: 7,
  severity: "warning",
  error_type: "scan-warning",
  error_message: "warning",
  affected_files: ["a.jpg"],
};

describe("session issue projection", () => {
  it("projects backend issues with the active session identity", () => {
    expect(projectSessionIssues(42, [backendIssue])).toEqual([
      { ...backendIssue, severity: "warning", scan_id: 42 },
    ]);
  });

  it("replaces the projection entirely from backend issues", () => {
    const previousBackend: ApplicationErrorPayload = {
      issue_id: 1,
      scan_id: 3,
      severity: "error",
      error_type: "old-backend",
      error_message: "old",
      affected_files: [],
    };
    expect(mergeSessionIssues([previousBackend], 42, [backendIssue])).toEqual([
      { ...backendIssue, severity: "warning", scan_id: 42 },
    ]);
  });

  it("normalises unknown backend severities to errors", () => {
    expect(
      projectSessionIssues(42, [{ ...backendIssue, severity: "unexpected" }]),
    ).toEqual([{ ...backendIssue, severity: "error", scan_id: 42 }]);
  });
});

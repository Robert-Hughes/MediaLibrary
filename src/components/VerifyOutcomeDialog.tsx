import { ModalDialog } from "./ModalDialog";
// Dialog to surface per-tag verification outcomes that need user attention.
//
// Mounted while `appState.verifyOutcomes` is non-empty.  Lists every Coerced /
// Mismatch / MissingPostWrite / DeleteLingering tag from the most recent apply
// run, grouped by file.  For Coerced entries the user can:
//
//   - Accept  — drop the draft so the "saved" view matches what exiftool wrote.
//   - Revert  — re-stage the draft with the value the file actually holds.
//
// Mismatch / MissingPostWrite / DeleteLingering rows are info-only here: the
// draft is retained, the user must edit it themselves to fix it, and they can
// dismiss the row from this dialog without changing anything.

import type { MetadataValue, TagOutcomeEntry } from "../types";
import {
  metadataEntryToDisplayString,
  metadataValueToDiagnosticString,
} from "../draft";

interface Props {
  outcomes: Record<string, TagOutcomeEntry[]>;
  onAccept: (file: string, tag: string) => void;
  onRevert: (file: string, tag: string, observed: MetadataValue | null) => void;
  onDismiss: (file: string, tag: string) => void;
  onDismissAll: () => void;
}

const KIND_BADGE: Record<string, { label: string; cls: string }> = {
  Coerced: { label: "Normalised", cls: "verify-badge verify-badge-coerced" },
  Mismatch: { label: "Mismatch", cls: "verify-badge verify-badge-mismatch" },
  MissingPostWrite: {
    label: "Not written",
    cls: "verify-badge verify-badge-mismatch",
  },
  DeleteLingering: {
    label: "Still present",
    cls: "verify-badge verify-badge-mismatch",
  },
};

function MetadataValueDiagnosticCell({
  value,
  title,
}: {
  value: MetadataValue | null | undefined;
  title?: string | null;
}) {
  const friendly = metadataEntryToDisplayString(value);
  const diagnostic = metadataValueToDiagnosticString(value);
  return (
    <div title={title || diagnostic}>
      <div>{friendly}</div>
      {diagnostic ? (
        <div
          className="verify-value-diagnostic"
          style={{
            color: "var(--text-muted)",
            fontFamily: "monospace",
            fontSize: 12,
            marginTop: 2,
            whiteSpace: "pre-wrap",
          }}
        >
          {diagnostic}
        </div>
      ) : null}
    </div>
  );
}

export function VerifyOutcomeDialog({
  outcomes,
  onAccept,
  onRevert,
  onDismiss,
  onDismissAll,
}: Props) {
  const fileEntries = Object.entries(outcomes);
  if (fileEntries.length === 0) return null;

  const totalRows = fileEntries.reduce((acc, [, list]) => acc + list.length, 0);

  return (
    <ModalDialog
      open
      onDismiss={onDismissAll}
      testId="verify-outcome-dialog"
      aria-label="Verification results"
    >
      <div
        className="dialog-content"
        style={{ width: 640, maxHeight: "80vh", overflowY: "auto" }}
      >
        <div className="dialog-header">
          <span className="dialog-title">
            Apply finished — {totalRows} tag{totalRows === 1 ? "" : "s"} need
            attention
          </span>
        </div>
        <div className="dialog-body">
          <p className="dialog-hint">
            ExifTool either normalised your value, rejected the write, or could
            not remove the tag. Choose what to do for each entry.
          </p>
          {fileEntries.map(([file, list]) => (
            <div key={file} style={{ marginTop: 12 }}>
              <div
                style={{ fontWeight: 600, marginBottom: 4 }}
                data-testid={`verify-outcome-file-${file}`}
              >
                {file}
              </div>
              <table
                className="verify-outcome-table"
                style={{ width: "100%", borderCollapse: "collapse" }}
              >
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>
                      Tag
                    </th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>
                      Sent
                    </th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>
                      File now holds
                    </th>
                    <th style={{ textAlign: "left", padding: "4px 6px" }}>
                      Status
                    </th>
                    <th style={{ textAlign: "right", padding: "4px 6px" }}>
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((entry) => {
                    const badge = KIND_BADGE[entry.kind] ?? {
                      label: entry.kind,
                      cls: "verify-badge",
                    };
                    const observedForRevert = entry.observed ?? null;
                    return (
                      <tr
                        key={entry.tag}
                        data-testid={`verify-outcome-row-${file}-${entry.tag}`}
                      >
                        <td
                          style={{
                            padding: "4px 6px",
                            fontFamily: "monospace",
                          }}
                        >
                          {entry.tag}
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <MetadataValueDiagnosticCell
                            value={entry.sent}
                            title={entry.message}
                          />
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <MetadataValueDiagnosticCell
                            value={entry.observed}
                            title={entry.message}
                          />
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <span
                            className={badge.cls}
                            title={entry.message ?? ""}
                          >
                            {badge.label}
                          </span>
                        </td>
                        <td
                          style={{
                            padding: "4px 6px",
                            textAlign: "right",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {entry.kind === "Coerced" ? (
                            <>
                              <button
                                className="dialog-btn dialog-btn-secondary"
                                onClick={() =>
                                  onRevert(file, entry.tag, observedForRevert)
                                }
                                data-testid={`verify-outcome-revert-${file}-${entry.tag}`}
                                title="Re-stage the draft with the value the file now holds"
                              >
                                Revert
                              </button>{" "}
                              <button
                                className="dialog-btn dialog-btn-primary"
                                onClick={() => onAccept(file, entry.tag)}
                                data-testid={`verify-outcome-accept-${file}-${entry.tag}`}
                                title="Drop the draft and accept what ExifTool wrote"
                              >
                                Accept
                              </button>
                            </>
                          ) : (
                            <button
                              className="dialog-btn dialog-btn-secondary"
                              onClick={() => onDismiss(file, entry.tag)}
                              data-testid={`verify-outcome-dismiss-${file}-${entry.tag}`}
                              title="Hide this row; the draft stays so you can fix it"
                            >
                              Dismiss
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
        <div className="dialog-footer">
          <button
            className="dialog-btn dialog-btn-secondary"
            onClick={onDismissAll}
            data-testid="verify-outcome-dismiss-all"
          >
            Close
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

export default VerifyOutcomeDialog;

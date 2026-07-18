import type { MetadataDraftTarget, MetadataValue } from "../types";
import {
  targetVerifyPrimaryAction,
  type TargetVerifyOutcomesByFile,
} from "../targetVerifyOutcomes";
import {
  metadataEntryToDisplayString,
  metadataValueToDiagnosticString,
} from "../draft";
import { formatMetadataOccurrenceIdForDiagnostics } from "../utils/metadataOccurrenceId";
import { formatSchemaDefinitionIdForDiagnostics } from "../utils/schemaDefinitionId";
import { metadataDraftTargetSlotToken } from "../utils/metadataDraftTarget";
import { metadataWriteSelector } from "../utils/metadataWriteTarget";
import { ModalDialog } from "./ModalDialog";

interface Props {
  outcomes: TargetVerifyOutcomesByFile;
  onAccept: (file: string, target: MetadataDraftTarget) => void;
  onKeep: (file: string, target: MetadataDraftTarget) => void;
  onDiscard: (file: string, target: MetadataDraftTarget) => void;
  onDismissAll: () => void;
}

function Value({ value }: { value: MetadataValue | null }) {
  const diagnostic = metadataValueToDiagnosticString(value);
  return (
    <div title={diagnostic}>
      <div>{metadataEntryToDisplayString(value)}</div>
      {diagnostic ? (
        <div className="verify-value-diagnostic">{diagnostic}</div>
      ) : null}
    </div>
  );
}

function TargetDescription({ target }: { target: MetadataDraftTarget }) {
  const schema = formatSchemaDefinitionIdForDiagnostics(target.schema_id);
  if (target.kind === "NewProperty") {
    return (
      <div>
        <strong>New Property</strong>
        <div className="verify-value-diagnostic">Schema: {schema}</div>
        <div className="verify-value-diagnostic">
          Write target: {metadataWriteSelector(target.write_target)}
        </div>
      </div>
    );
  }
  return (
    <div>
      <strong>Existing Occurrence</strong>
      <div className="verify-value-diagnostic">
        {formatMetadataOccurrenceIdForDiagnostics(target.occurrence_id)}
      </div>
      <div className="verify-value-diagnostic">Schema: {schema}</div>
      <div className="verify-value-diagnostic">
        Write target: {metadataWriteSelector(target.write_target)}
      </div>
    </div>
  );
}

export function TargetVerifyOutcomeDialog({
  outcomes,
  onAccept,
  onKeep,
  onDiscard,
  onDismissAll,
}: Props) {
  const files = Object.entries(outcomes);
  if (files.length === 0) return null;
  const total = files.reduce(
    (count, [, entries]) => count + Object.keys(entries).length,
    0,
  );

  return (
    <ModalDialog
      open
      onDismiss={onDismissAll}
      testId="target-verify-outcome-dialog"
      aria-label="Target verification results"
    >
      <div
        className="dialog-content"
        style={{ width: 920, maxHeight: "85vh", overflowY: "auto" }}
      >
        <div className="dialog-header">
          <span className="dialog-title">
            Apply finished — {total} target{total === 1 ? "" : "s"} need
            attention
          </span>
        </div>
        <div className="dialog-body">
          <p className="dialog-hint">
            Review the exact persisted draft target and choose whether to accept
            the file state, keep the draft, or discard it.
          </p>
          {files.map(([file, entries]) => (
            <section
              key={file}
              data-testid={`target-verify-file-${file}`}
              style={{ marginTop: 16 }}
            >
              <h3 style={{ margin: "0 0 8px" }}>{file}</h3>
              {Object.values(entries).map((entry) => {
                const slot = metadataDraftTargetSlotToken(entry.currentTarget);
                const blocked = entry.reconciliation.kind === "Blocked";
                const primaryAction = targetVerifyPrimaryAction(entry);
                const blockedReason =
                  entry.reconciliation.kind === "Blocked"
                    ? entry.reconciliation.reason
                    : null;
                return (
                  <article
                    key={slot}
                    data-testid={`target-verify-row-${file}-${slot}`}
                    style={{
                      border: "1px solid var(--border-color)",
                      borderRadius: 6,
                      padding: 12,
                      marginBottom: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 16,
                      }}
                    >
                      <div>
                        <strong>{entry.displayName}</strong>
                        <TargetDescription target={entry.currentTarget} />
                        {entry.reconciliation.kind === "Replace" ? (
                          <div className="dialog-hint" style={{ marginTop: 6 }}>
                            Submitted as{" "}
                            <TargetDescription target={entry.originalTarget} />
                          </div>
                        ) : null}
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <span className="verify-badge">{entry.kind}</span>
                        <div>
                          Reconciliation:{" "}
                          <strong>{entry.reconciliation.kind}</strong>
                        </div>
                      </div>
                    </div>
                    {blocked ? (
                      <div
                        role="alert"
                        data-testid="target-verify-blocked-reason"
                        style={{ marginTop: 10, fontWeight: 600 }}
                      >
                        Blocked: {blockedReason}
                      </div>
                    ) : null}
                    <table
                      className="verify-outcome-table"
                      style={{ width: "100%", marginTop: 10 }}
                    >
                      <thead>
                        <tr>
                          <th>Sent</th>
                          <th>Previous</th>
                          <th>Observed</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td>
                            <Value value={entry.sent} />
                          </td>
                          <td>
                            <Value value={entry.before} />
                          </td>
                          <td>
                            <Value value={entry.observed} />
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    {entry.message ? (
                      <p data-testid="target-verify-message">{entry.message}</p>
                    ) : null}
                    <div style={{ textAlign: "right", marginTop: 10 }}>
                      <button
                        className="dialog-btn dialog-btn-secondary"
                        onClick={() => onKeep(file, entry.currentTarget)}
                      >
                        Keep draft
                      </button>{" "}
                      {primaryAction === "discard-pending-draft" ? (
                        <button
                          className="dialog-btn dialog-btn-primary"
                          onClick={() => onDiscard(file, entry.currentTarget)}
                        >
                          Discard pending draft
                        </button>
                      ) : (
                        <button
                          className="dialog-btn dialog-btn-primary"
                          onClick={() => onAccept(file, entry.currentTarget)}
                        >
                          Accept written/current file state
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
        <div className="dialog-footer">
          <button
            className="dialog-btn dialog-btn-secondary"
            onClick={onDismissAll}
          >
            Close
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

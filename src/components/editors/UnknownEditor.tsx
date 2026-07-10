import type { MetadataValue } from "../../types";

interface Props {
  propertyKey: string;
  initialMetadataValue?: MetadataValue;
  onCancel: () => void;
  headerHint?: React.ReactNode;
}

export function UnknownEditor({
  propertyKey,
  initialMetadataValue,
  onCancel,
  headerHint,
}: Props) {
  const isParsedUnknown =
    initialMetadataValue && initialMetadataValue.kind === "Unknown";
  const rawValue = isParsedUnknown
    ? initialMetadataValue.value.raw
    : (initialMetadataValue ?? null);
  const reason = isParsedUnknown ? initialMetadataValue.value.reason : null;

  return (
    <div className="dialog-overlay" data-testid="unknown-editor-overlay">
      <div className="dialog-content">
        <h3>{propertyKey}</h3>
        {headerHint}
        <div className="dialog-body">
          <p className="dialog-hint" data-testid="unknown-editor-explanation">
            {!isParsedUnknown
              ? "MediaLibrary does not know the schema for this tag."
              : "MediaLibrary could not confidently parse this metadata value."}
          </p>

          <div
            className="unknown-editor-details"
            style={{ marginTop: 12, marginBottom: 12 }}
          >
            <div style={{ fontWeight: "bold", marginBottom: 4 }}>
              Raw / Display Value:
            </div>
            <pre
              style={{
                background: "rgba(0,0,0,0.05)",
                padding: 8,
                borderRadius: 4,
                overflowX: "auto",
                margin: 0,
                fontSize: "0.9em",
              }}
              data-testid="unknown-editor-raw-value"
            >
              {typeof rawValue === "object"
                ? JSON.stringify(rawValue, null, 2)
                : String(rawValue ?? "")}
            </pre>

            {reason && (
              <div style={{ marginTop: 8 }}>
                <span style={{ fontWeight: "bold" }}>Parse Reason: </span>
                <span data-testid="unknown-editor-reason">{reason}</span>
              </div>
            )}
          </div>

          <p
            className="dialog-hint"
            style={{ color: "var(--color-warning-text, #c97c00)" }}
          >
            Editing this tag as plain text could destroy structure or type
            information. Editing is disabled.
          </p>
        </div>
        <div className="dialog-footer">
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={onCancel}
            data-testid="unknown-editor-close"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

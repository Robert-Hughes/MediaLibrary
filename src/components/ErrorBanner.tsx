import { WorkerErrorPayload } from "../types";

interface Props {
  errors: WorkerErrorPayload[];
  onDismiss: (index: number) => void;
}

export function ErrorBanner({ errors, onDismiss }: Props) {
  if (errors.length === 0) return null;

  return (
    <div className="error-banner-container">
      {errors.map((error, index) => (
        <div key={index} className="error-banner" data-testid="error-banner">
          <div className="error-banner-content">
            <span className="error-banner-icon">⚠️</span>
            <div className="error-banner-text">
              <div className="error-banner-title">
                {error.worker_type === "metadata" && "Metadata Loading Error"}
                {error.worker_type === "thumbnail" &&
                  "Thumbnail Generation Error"}
                {error.worker_type === "scanner" && "Scanning Error"}
              </div>
              <div className="error-banner-message">{error.error_message}</div>
              {error.affected_files.length > 0 && (
                <div className="error-banner-files">
                  Affected files: {error.affected_files.slice(0, 3).join(", ")}
                  {error.affected_files.length > 3 &&
                    ` and ${error.affected_files.length - 3} more`}
                </div>
              )}
            </div>
          </div>
          <button
            className="error-banner-close"
            onClick={() => onDismiss(index)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

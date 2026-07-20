import { useCallback, useEffect, useRef } from "react";
import { ApplicationErrorPayload } from "../types";
import { listenForApplicationErrorBringToFront } from "../applicationErrorTopLayer";

interface Props {
  errors: ApplicationErrorPayload[];
  onDismiss: (index: number) => void;
}

function applicationErrorTitle(error: ApplicationErrorPayload): string {
  switch (error.error_type) {
    case "metadata":
      return "Metadata Loading Error";
    case "thumbnail":
      return "Thumbnail Generation Error";
    case "scanner":
      return "Scanning Error";
    case "apply":
      return "Apply Error";
    case "apply-warning":
      return "Apply Warning";
    default:
      return error.severity === "warning"
        ? "Application Warning"
        : "Application Error";
  }
}

export function ErrorBanner({ errors, onDismiss }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverOpenRef = useRef(false);
  const newestError = errors[errors.length - 1];

  const bringToFront = useCallback(() => {
    const container = containerRef.current;
    if (!container || errors.length === 0) return;
    if (popoverOpenRef.current) container.hidePopover();
    container.showPopover();
    popoverOpenRef.current = true;
  }, [errors.length]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (errors.length === 0) {
      if (popoverOpenRef.current) container.hidePopover();
      popoverOpenRef.current = false;
      return;
    }
    bringToFront();
  }, [bringToFront, newestError]);

  useEffect(
    () => listenForApplicationErrorBringToFront(bringToFront),
    [bringToFront],
  );

  return (
    <div
      ref={containerRef}
      className="error-banner-container"
      popover="manual"
      data-testid="application-error-popover"
    >
      {errors.map((error, index) => (
        <div
          key={index}
          className={`error-banner error-banner--${error.severity}`}
          data-testid="error-banner"
        >
          <div className="error-banner-content">
            <span className="error-banner-icon">
              {error.severity === "warning" ? "⚠️" : "⛔"}
            </span>
            <div className="error-banner-text">
              <div className="error-banner-title">
                {applicationErrorTitle(error)}
              </div>
              <div className="error-banner-code">{error.error_type}</div>
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

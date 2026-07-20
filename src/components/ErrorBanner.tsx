import { useCallback, useEffect, useRef } from "react";
import { ApplicationErrorPayload } from "../types";
import { listenForApplicationErrorBringToFront } from "../applicationErrorTopLayer";

interface Props {
  errors: ApplicationErrorPayload[];
  onDismiss: (index: number) => void;
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
        <div key={index} className="error-banner" data-testid="error-banner">
          <div className="error-banner-content">
            <span className="error-banner-icon">⚠️</span>
            <div className="error-banner-text">
              <div className="error-banner-title">
                {error.error_type === "metadata" && "Metadata Loading Error"}
                {error.error_type === "thumbnail" &&
                  "Thumbnail Generation Error"}
                {error.error_type === "scanner" && "Scanning Error"}
                {error.error_type === "apply" && "Apply Error"}
                {error.error_type === "apply-warning" && "Apply Warning"}
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

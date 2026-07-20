import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBanner } from "../components/ErrorBanner";
import { ModalDialog } from "../components/ModalDialog";
import type { ApplicationErrorPayload } from "../types";

const error: ApplicationErrorPayload = {
  scan_id: 1,
  severity: "error",
  error_type: "test-error",
  error_message: "Something failed",
  affected_files: ["photo.jpg"],
};

describe("ErrorBanner top-layer presentation", () => {
  it("shows errors in a manual popover", () => {
    const show = vi.spyOn(HTMLElement.prototype, "showPopover");
    render(<ErrorBanner errors={[error]} onDismiss={vi.fn()} />);

    expect(screen.getByTestId("application-error-popover")).toHaveAttribute(
      "popover",
      "manual",
    );
    expect(screen.getByText("Application Error")).toBeInTheDocument();
    expect(screen.getByText("test-error")).toBeInTheDocument();
    expect(show).toHaveBeenCalledOnce();
    show.mockRestore();
  });

  it("returns an existing error popover to the front after a modal opens", () => {
    const show = vi.spyOn(HTMLElement.prototype, "showPopover");
    const hide = vi.spyOn(HTMLElement.prototype, "hidePopover");
    const dismiss = vi.fn();
    const { rerender } = render(
      <ErrorBanner errors={[error]} onDismiss={dismiss} />,
    );
    rerender(
      <>
        <ErrorBanner errors={[error]} onDismiss={dismiss} />
        <ModalDialog open onDismiss={vi.fn()} aria-label="Test dialog">
          body
        </ModalDialog>
      </>,
    );

    expect(show).toHaveBeenCalledTimes(2);
    expect(hide).toHaveBeenCalledOnce();
    show.mockRestore();
    hide.mockRestore();
  });
});

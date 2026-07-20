import { fireEvent, render, screen } from "@testing-library/react";
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

  it("portals into the active modal so its dismissal remains interactive", () => {
    const dismiss = vi.fn();
    render(
      <>
        <ErrorBanner errors={[error]} onDismiss={dismiss} />
        <ModalDialog open onDismiss={vi.fn()} aria-label="Test dialog">
          body
        </ModalDialog>
      </>,
    );

    const dialog = screen.getByRole("dialog");
    expect(
      dialog.contains(screen.getByTestId("application-error-popover")),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(dismiss).toHaveBeenCalledWith(0);
  });

  it("follows nested dialogs back to the body as they open and close", () => {
    const dismiss = vi.fn();
    const banner = <ErrorBanner errors={[error]} onDismiss={dismiss} />;
    const outer = (
      <ModalDialog open onDismiss={vi.fn()} aria-label="Outer dialog">
        outer
      </ModalDialog>
    );
    const inner = (
      <ModalDialog open onDismiss={vi.fn()} aria-label="Inner dialog">
        inner
      </ModalDialog>
    );
    const { rerender } = render(banner);
    expect(
      screen.getByTestId("application-error-popover").closest("dialog"),
    ).toBeNull();

    rerender(
      <>
        {banner}
        {outer}
      </>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "Outer dialog" })
        .contains(screen.getByTestId("application-error-popover")),
    ).toBe(true);

    rerender(
      <>
        {banner}
        {outer}
        {inner}
      </>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "Inner dialog" })
        .contains(screen.getByTestId("application-error-popover")),
    ).toBe(true);

    rerender(
      <>
        {banner}
        {outer}
      </>,
    );
    expect(
      screen
        .getByRole("dialog", { name: "Outer dialog" })
        .contains(screen.getByTestId("application-error-popover")),
    ).toBe(true);

    rerender(banner);
    expect(
      screen.getByTestId("application-error-popover").closest("dialog"),
    ).toBeNull();
  });
});

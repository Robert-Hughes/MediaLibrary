import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModalDialog } from "../components/ModalDialog";

describe("ModalDialog", () => {
  it("synchronises native open state without duplicate calls", () => {
    const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const { rerender, unmount } = render(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(show).toHaveBeenCalledTimes(1);
    rerender(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(show).toHaveBeenCalledTimes(1);
    rerender(
      <ModalDialog open={false} onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(close).toHaveBeenCalledTimes(1);
    rerender(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    unmount();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("routes cancel through controlled dismissal", () => {
    const dismiss = vi.fn();
    render(
      <ModalDialog open onDismiss={dismiss} aria-labelledby="heading">
        <h2 id="heading">Named</h2>
      </ModalDialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Named" });
    const event = new Event("cancel", { bubbles: false, cancelable: true });
    dialog.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("refuses cancel when non-dismissible", () => {
    const dismiss = vi.fn();
    render(
      <ModalDialog
        open
        dismissible={false}
        onDismiss={dismiss}
        aria-label="Busy"
      >
        body
      </ModalDialog>,
    );
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    expect(dismiss).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveAttribute("open");
  });

  it("dismisses from the backdrop only when opted in", () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(dismiss).not.toHaveBeenCalled();
    rerender(
      <ModalDialog open dismissOnBackdrop onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

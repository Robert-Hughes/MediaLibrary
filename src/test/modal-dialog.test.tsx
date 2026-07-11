import { act, fireEvent, render, screen } from "@testing-library/react";
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

  it("gives cancellation ownership to the exact nested dialog", () => {
    const parentDismiss = vi.fn();
    const childDismiss = vi.fn();
    render(
      <ModalDialog open onDismiss={parentDismiss} aria-label="Parent">
        <ModalDialog open onDismiss={childDismiss} aria-label="Child">
          child
        </ModalDialog>
      </ModalDialog>,
    );

    const childEvent = new Event("cancel", {
      bubbles: true,
      cancelable: true,
    });
    screen.getByRole("dialog", { name: "Child" }).dispatchEvent(childEvent);
    expect(childEvent.defaultPrevented).toBe(true);
    expect(childDismiss).toHaveBeenCalledOnce();
    expect(parentDismiss).not.toHaveBeenCalled();

    const parentEvent = new Event("cancel", { cancelable: true });
    screen.getByRole("dialog", { name: "Parent" }).dispatchEvent(parentEvent);
    expect(parentDismiss).toHaveBeenCalledOnce();
    expect(childDismiss).toHaveBeenCalledOnce();
  });

  it("does not dismiss again after a controlled close", () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    rerender(
      <ModalDialog open={false} onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("restores focus through a controlled native close", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { rerender } = render(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Child">
        <button autoFocus>Initial control</button>
      </ModalDialog>,
    );
    expect(
      screen.getByRole("button", { name: "Initial control" }),
    ).toHaveFocus();
    rerender(
      <ModalDialog open={false} onDismiss={vi.fn()} aria-label="Child">
        <button autoFocus>Initial control</button>
      </ModalDialog>,
    );
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("reconciles an unexpected native close through dismissal", () => {
    const dismiss = vi.fn();
    render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    (screen.getByRole("dialog") as HTMLDialogElement).close();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("reopens a non-dismissible dialog after an unexpected close", async () => {
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
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    dialog.close();
    await act(async () => {});
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAttribute("closedby", "none");
    expect(dismiss).not.toHaveBeenCalled();
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
        <span>body</span>
      </ModalDialog>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(dismiss).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("body"));
    expect(dismiss).toHaveBeenCalledOnce();
  });
});

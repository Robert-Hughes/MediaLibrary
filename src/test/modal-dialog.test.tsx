import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ModalDialog } from "../components/ModalDialog";
import { flushDialogCloseEvents } from "./setup";

describe("ModalDialog", () => {
  // ── closedby policy ─────────────────────────────────────────────────────

  it("maps dismissibility to the native close-request policy", () => {
    const { rerender } = render(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute(
      "closedby",
      "closerequest",
    );
    rerender(
      <ModalDialog
        open
        dismissible={false}
        onDismiss={vi.fn()}
        aria-label="Test"
      >
        body
      </ModalDialog>,
    );
    expect(screen.getByRole("dialog")).toHaveAttribute("closedby", "none");
  });

  // ── open/close synchronisation ──────────────────────────────────────────

  it("synchronises native open state without duplicate calls", async () => {
    const show = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const close = vi.spyOn(HTMLDialogElement.prototype, "close");
    const { rerender, unmount } = render(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(show).toHaveBeenCalledTimes(1);

    // Re-render with same open=true — no duplicate showModal
    rerender(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(show).toHaveBeenCalledTimes(1);

    // Close via prop
    rerender(
      <ModalDialog open={false} onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(close).toHaveBeenCalledTimes(1);

    // Reopen
    rerender(
      <ModalDialog open onDismiss={vi.fn()} aria-label="Test">
        body
      </ModalDialog>,
    );
    expect(show).toHaveBeenCalledTimes(2);

    // Unmounting must NOT call dialog.close() — the browser removes the
    // element from the top layer automatically.
    const closeCountBeforeUnmount = close.mock.calls.length;
    unmount();
    expect(close).toHaveBeenCalledTimes(closeCountBeforeUnmount);
  });

  // ── cancel handling ─────────────────────────────────────────────────────

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

  // ── controlled close (async close event) ────────────────────────────────

  it("does not dismiss after a controlled close", async () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );

    // Close via prop
    rerender(
      <ModalDialog open={false} onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );

    // Let the queued close event arrive
    await flushDialogCloseEvents();

    expect(dismiss).not.toHaveBeenCalled();
  });

  it("does not dismiss when reopened before old close event arrives", async () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;

    // Close via prop
    rerender(
      <ModalDialog open={false} onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );

    // Immediately reopen before the close event arrives
    rerender(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );

    // Old close event arrives now
    await flushDialogCloseEvents();

    expect(dialog).toHaveAttribute("open");
    expect(dismiss).not.toHaveBeenCalled();
  });

  // ── unexpected close (async close event) ────────────────────────────────

  it("reconciles an unexpected native close through dismissal", async () => {
    const dismiss = vi.fn();
    render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    (screen.getByRole("dialog") as HTMLDialogElement).close();

    // Close event not arrived yet
    expect(dismiss).not.toHaveBeenCalled();

    // Flush the queued close event
    await flushDialogCloseEvents();

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

    // Flush the queued close event + the reopen microtask
    await flushDialogCloseEvents();
    await act(async () => {});

    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAttribute("closedby", "none");
    expect(dismiss).not.toHaveBeenCalled();
  });

  // ── multiple outstanding expected close events ──────────────────────────

  it("handles multiple outstanding expected close events without false dismissal", async () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Multi">
        body
      </ModalDialog>,
    );
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;

    // Close #1
    rerender(
      <ModalDialog open={false} onDismiss={dismiss} aria-label="Multi">
        body
      </ModalDialog>,
    );

    // Reopen
    rerender(
      <ModalDialog open onDismiss={dismiss} aria-label="Multi">
        body
      </ModalDialog>,
    );

    // Close #2
    rerender(
      <ModalDialog open={false} onDismiss={dismiss} aria-label="Multi">
        body
      </ModalDialog>,
    );

    // Reopen again
    rerender(
      <ModalDialog open onDismiss={dismiss} aria-label="Multi">
        body
      </ModalDialog>,
    );

    // Both delayed close events arrive
    await flushDialogCloseEvents();

    // Dialog must remain open, dismiss must not have been called
    expect(dialog).toHaveAttribute("open");
    expect(dismiss).not.toHaveBeenCalled();

    // Now an unexpected native close should still trigger dismiss
    dialog.close();
    await flushDialogCloseEvents();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  // ── repeated controlled cycles ──────────────────────────────────────────

  it("supports closing and reopening the same mounted dialog", async () => {
    const dismiss = vi.fn();
    const { rerender } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Cycle">
        body
      </ModalDialog>,
    );
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;

    // close
    rerender(
      <ModalDialog open={false} onDismiss={dismiss} aria-label="Cycle">
        body
      </ModalDialog>,
    );
    expect(dialog).not.toHaveAttribute("open");

    // reopen
    rerender(
      <ModalDialog open onDismiss={dismiss} aria-label="Cycle">
        body
      </ModalDialog>,
    );
    expect(dialog).toHaveAttribute("open");

    // Flush old close events
    await flushDialogCloseEvents();

    // Unexpected close on the reopened dialog
    dialog.close();
    await flushDialogCloseEvents();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  // ── Strict Mode regression ──────────────────────────────────────────────

  it("dialog remains open under React Strict Mode", async () => {
    const dismiss = vi.fn();
    render(
      <React.StrictMode>
        <ModalDialog open onDismiss={dismiss} aria-label="Strict dialog">
          <button autoFocus>Inside</button>
        </ModalDialog>
      </React.StrictMode>,
    );

    // Allow Strict Mode effect replay and all queued close-event tasks to run
    await flushDialogCloseEvents();

    const dialog = screen.getByRole("dialog", { name: "Strict dialog" });
    expect(dialog).toHaveAttribute("open");
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("Strict Mode + dismissible unexpected close still calls onDismiss", async () => {
    const dismiss = vi.fn();
    render(
      <React.StrictMode>
        <ModalDialog open onDismiss={dismiss} aria-label="Strict dialog">
          body
        </ModalDialog>
      </React.StrictMode>,
    );

    await flushDialogCloseEvents();

    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    dialog.close();
    await flushDialogCloseEvents();
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it("Strict Mode + non-dismissible reopens after unexpected close", async () => {
    const dismiss = vi.fn();
    render(
      <React.StrictMode>
        <ModalDialog
          open
          dismissible={false}
          onDismiss={dismiss}
          aria-label="Strict dialog"
        >
          body
        </ModalDialog>
      </React.StrictMode>,
    );

    await flushDialogCloseEvents();

    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    dialog.close();
    await flushDialogCloseEvents();
    await act(async () => {});

    expect(dialog).toHaveAttribute("open");
    expect(dismiss).not.toHaveBeenCalled();
  });

  // ── focus restoration ───────────────────────────────────────────────────

  it("restores focus through a controlled native close", async () => {
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

    // The shim restores focus synchronously on close(); the close event
    // arrives asynchronously.
    await flushDialogCloseEvents();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("restores focus on conditional unmount of an open dialog", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Opener";
    document.body.appendChild(opener);
    opener.focus();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Open settings</button>
          {open && (
            <ModalDialog
              open
              onDismiss={() => setOpen(false)}
              aria-label="Settings"
            >
              <button autoFocus>Close</button>
            </ModalDialog>
          )}
        </>
      );
    }

    render(<Harness />);

    // Open the dialog
    await userEvent.click(
      screen.getByRole("button", { name: "Open settings" }),
    );
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveAttribute(
      "open",
    );
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    // Cancel (dismiss) the dialog — causes conditional unmount
    await act(async () => {
      fireEvent(
        screen.getByRole("dialog", { name: "Settings" }),
        new Event("cancel", { cancelable: true }),
      );
    });

    // Wait for the focus-restoration microtask
    await flushDialogCloseEvents();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open settings" }),
    ).toHaveFocus();

    opener.remove();
  });

  it("does not steal focus from a newly opened replacement dialog", async () => {
    function Harness() {
      const [which, setWhich] = useState<"a" | "b" | null>("a");
      return (
        <>
          <button onClick={() => setWhich("b")}>Switch</button>
          {which === "a" && (
            <ModalDialog
              open
              onDismiss={() => setWhich(null)}
              aria-label="Dialog A"
            >
              <button autoFocus>A control</button>
            </ModalDialog>
          )}
          {which === "b" && (
            <ModalDialog
              open
              onDismiss={() => setWhich(null)}
              aria-label="Dialog B"
            >
              <button autoFocus>B control</button>
            </ModalDialog>
          )}
        </>
      );
    }

    render(<Harness />);
    expect(screen.getByRole("button", { name: "A control" })).toHaveFocus();

    // Switch from A to B
    await userEvent.click(screen.getByRole("button", { name: "Switch" }));
    await act(async () => {});

    // B should now have focus, not the outer button
    expect(screen.getByRole("button", { name: "B control" })).toHaveFocus();
  });

  // ── unmount does not call dialog.close() ────────────────────────────────

  it("unmounting does not produce a native close event from production code", async () => {
    const dismiss = vi.fn();
    const closeSpy = vi.spyOn(HTMLDialogElement.prototype, "close");
    const { unmount } = render(
      <ModalDialog open onDismiss={dismiss} aria-label="Test">
        body
      </ModalDialog>,
    );
    const callsBefore = closeSpy.mock.calls.length;
    unmount();

    // Production code must not have called dialog.close()
    expect(closeSpy).toHaveBeenCalledTimes(callsBefore);

    // No close events should arrive
    await flushDialogCloseEvents();
    expect(dismiss).not.toHaveBeenCalled();
  });
});

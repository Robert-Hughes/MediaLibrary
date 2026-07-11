import {
  type KeyboardEventHandler,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";

export interface ModalDialogProps {
  open: boolean;
  onDismiss: () => void;
  dismissible?: boolean;
  className?: string;
  testId?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  children: ReactNode;
}

let previouslyFocused: HTMLElement | null = null;
let lastFocused: HTMLElement | null = null;

if (typeof document !== "undefined") {
  document.addEventListener("focusin", (event) => {
    previouslyFocused = lastFocused;
    lastFocused = event.target instanceof HTMLElement ? event.target : null;
  });
}

/** A controlled native modal. React state always remains authoritative. */
export function ModalDialog({
  open,
  onDismiss,
  dismissible = true,
  className,
  testId,
  children,
  onKeyDown,
  ...aria
}: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const expectedCloseEventsRef = useRef(0);
  const openerRef = useRef<HTMLElement | null>(null);
  const lifecycleGenerationRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  // Synchronise native dialog state with React's `open` prop.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    dialog.setAttribute("closedby", dismissible ? "closerequest" : "none");

    if (open && !dialog.open) {
      const active = document.activeElement;
      openerRef.current =
        active instanceof HTMLElement
          ? dialog.contains(active)
            ? previouslyFocused
            : active
          : null;

      dialog.showModal();

      if (!dialog.contains(document.activeElement)) {
        const initial = dialog.querySelector<HTMLElement>("[autofocus]");
        initial?.focus();
      }
    } else if (!open && dialog.open) {
      expectedCloseEventsRef.current += 1;
      dialog.close();
    }
  }, [dismissible, open]);

  // Strict Mode-safe focus restoration on genuine unmount.
  // Does NOT call dialog.close() — the browser removes the dialog from the
  // top layer automatically when its element is disconnected.
  //
  // Intentional: cleanup must read ref.current at teardown time (not setup
  // time) to check whether the dialog is currently open.
  // lifecycleGenerationRef.current is compared via the local
  // `cleanupGeneration` snapshot inside the microtask.
  /* eslint-disable react-hooks/exhaustive-deps */
  useLayoutEffect(() => {
    ++lifecycleGenerationRef.current;

    return () => {
      const dialog = ref.current;
      // React removes the DOM node before running layout-effect cleanup,
      // so by this point focus has already moved to <body> if the dialog
      // previously held focus.  We check dialog.open (the attribute
      // survives disconnection) and whether focus is currently unclaimed.
      const active = document.activeElement;
      const focusIsUnclaimed =
        active === document.body ||
        active == null ||
        !(active instanceof HTMLElement) ||
        !active.isConnected;

      const shouldRestoreFocus =
        dialog?.getAttribute("open") != null &&
        (focusIsUnclaimed || (active instanceof HTMLElement && dialog.contains(active)));

      const cleanupGeneration = ++lifecycleGenerationRef.current;

      if (!shouldRestoreFocus) return;

      queueMicrotask(() => {
        // If another setup ran after this cleanup, this was a Strict Mode
        // simulated cleanup — do nothing.
        const opener = openerRef.current;
        const currentActive = document.activeElement;

        const stillUnclaimed =
          currentActive === document.body ||
          currentActive == null ||
          !(currentActive instanceof HTMLElement) ||
          !currentActive.isConnected;

        if (lifecycleGenerationRef.current !== cleanupGeneration) return;

        if (opener?.isConnected && stillUnclaimed) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, []);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <dialog
      ref={ref}
      className={["modal-dialog", className].filter(Boolean).join(" ")}
      data-testid={testId}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (dismissible) onDismiss();
      }}
      onClose={() => {
        // Consume expected close events from controlled closes.
        if (expectedCloseEventsRef.current > 0) {
          expectedCloseEventsRef.current -= 1;
          return;
        }

        // Already closed from React's perspective — nothing to reconcile.
        if (!openRef.current) return;

        // Genuinely unexpected native close.
        if (dismissible) {
          onDismiss();
          return;
        }

        // Non-dismissible: reopen if still mounted and React says open.
        queueMicrotask(() => {
          const dialog = ref.current;
          if (dialog?.isConnected && openRef.current && !dialog.open) {
            dialog.showModal();
          }
        });
      }}
      onKeyDown={onKeyDown}
      {...aria}
    >
      {children}
    </dialog>
  );
}

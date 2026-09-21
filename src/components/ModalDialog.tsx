import {
  type KeyboardEventHandler,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";
import { registerApplicationErrorDialog } from "../applicationErrorTopLayer";

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

interface ModalFocusTracker {
  previous: HTMLElement | null;
  last: HTMLElement | null;
  installed: boolean;
}

const trackerGlobal = globalThis as typeof globalThis & {
  __mediaLibraryModalFocusTracker?: ModalFocusTracker;
};

// React can apply a descendant's autoFocus before this component's layout
// effect calls showModal(). In that case document.activeElement is already
// inside the dialog, so retain the preceding focused element as the opener
// for later focus restoration.
//
// This listener is intentionally installed once for the module/application lifetime.
const focusTracker =
  trackerGlobal.__mediaLibraryModalFocusTracker ??
  (trackerGlobal.__mediaLibraryModalFocusTracker = {
    previous: null,
    last: null,
    installed: false,
  });

if (typeof document !== "undefined" && !focusTracker.installed) {
  document.addEventListener("focusin", (event) => {
    focusTracker.previous = focusTracker.last;
    focusTracker.last =
      event.target instanceof HTMLElement ? event.target : null;
  });

  focusTracker.installed = true;
}

function focusModalInitialTarget(dialog: HTMLDialogElement) {
  const targets = dialog.querySelectorAll<HTMLElement>(
    '[data-modal-initial-focus="true"]',
  );
  for (const target of targets) {
    if (target.closest("dialog") === dialog) {
      target.focus();
      return;
    }
  }
}

function showModalWithInitialFocus(dialog: HTMLDialogElement) {
  dialog.showModal();
  focusModalInitialTarget(dialog);
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
  const unregisterApplicationErrorDialogRef = useRef<(() => void) | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  // Synchronise native dialog state with React's `open` prop.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    dialog.setAttribute("closedby", dismissible ? "closerequest" : "none");

    if (open) {
      if (!dialog.open) {
        const active = document.activeElement;
        const reactAutofocusTarget =
          active instanceof HTMLElement && dialog.contains(active)
            ? active
            : null;
        openerRef.current =
          active instanceof HTMLElement
            ? reactAutofocusTarget
              ? focusTracker.previous
              : active
            : null;

        // React may attempt descendant `autoFocus` before this parent
        // layout effect opens the native dialog. Some WebViews reject focus
        // inside a closed <dialog>; showModal() can then focus the first
        // focusable control instead. Open first, then honour the declarative
        // autofocus target owned by this dialog so Enter reaches the intended
        // default action consistently.
        showModalWithInitialFocus(dialog);
      }
      unregisterApplicationErrorDialogRef.current ??=
        registerApplicationErrorDialog(dialog);
    } else {
      unregisterApplicationErrorDialogRef.current?.();
      unregisterApplicationErrorDialogRef.current = null;
      if (dialog.open) {
        expectedCloseEventsRef.current += 1;
        dialog.close();
      }
    }

    return () => {
      unregisterApplicationErrorDialogRef.current?.();
      unregisterApplicationErrorDialogRef.current = null;
    };
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
      // During genuine unmount, focus may still be inside the dialog or may
      // already be unclaimed, depending on React commit and browser timing.
      // Handle both states without relying on one exact cleanup order.
      const active = document.activeElement;
      const focusIsUnclaimed =
        active === document.body ||
        active == null ||
        !(active instanceof HTMLElement) ||
        !active.isConnected;

      const shouldRestoreFocus =
        dialog?.getAttribute("open") != null &&
        (focusIsUnclaimed ||
          (active instanceof HTMLElement && dialog.contains(active)));

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
            showModalWithInitialFocus(dialog);
            unregisterApplicationErrorDialogRef.current?.();
            unregisterApplicationErrorDialogRef.current =
              registerApplicationErrorDialog(dialog);
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

import {
  type MouseEvent,
  type KeyboardEventHandler,
  type ReactNode,
  useLayoutEffect,
  useRef,
} from "react";

export interface ModalDialogProps {
  open: boolean;
  onDismiss: () => void;
  dismissible?: boolean;
  dismissOnBackdrop?: boolean;
  className?: string;
  testId?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  children: ReactNode;
}

/** A controlled native modal. React state always remains authoritative. */
export function ModalDialog({
  open,
  onDismiss,
  dismissible = true,
  dismissOnBackdrop = false,
  className,
  testId,
  children,
  onKeyDown,
  ...aria
}: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeReasonRef = useRef<"none" | "controlled" | "unmount">("none");
  const closeAttemptRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const openRef = useRef(open);
  openRef.current = open;

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    dialog.setAttribute("closedby", dismissible ? "closerequest" : "none");

    if (open && !dialog.open) {
      dialog.showModal();
      if (!dialog.contains(document.activeElement)) {
        const initial = dialog.querySelector<HTMLElement>("[autofocus]");
        initial?.focus();
      }
    } else if (!open && dialog.open) {
      const attempt = ++closeAttemptRef.current;
      closeReasonRef.current = "controlled";
      dialog.close();
      queueMicrotask(() => {
        if (closeAttemptRef.current === attempt)
          closeReasonRef.current = "none";
      });
    }
  }, [dismissible, open]);

  useLayoutEffect(() => {
    const lifecycleGeneration = lifecycleGenerationRef;
    const closeAttempt = closeAttemptRef;
    ++lifecycleGeneration.current;
    const dialog = ref.current;
    return () => {
      ++lifecycleGeneration.current;
      if (dialog?.open) {
        const attempt = ++closeAttempt.current;
        closeReasonRef.current = "unmount";
        dialog.close();
        queueMicrotask(() => {
          if (closeAttempt.current === attempt) {
            closeReasonRef.current = "none";
          }
        });
      }
    };
  }, []);

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (
      dismissible &&
      dismissOnBackdrop &&
      event.target === event.currentTarget
    ) {
      onDismiss();
    }
  };

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
        if (closeReasonRef.current !== "none") {
          closeReasonRef.current = "none";
          return;
        }
        if (!openRef.current) return;
        if (dismissible) {
          onDismiss();
          return;
        }
        const generation = lifecycleGenerationRef.current;
        queueMicrotask(() => {
          const dialog = ref.current;
          if (
            dialog &&
            openRef.current &&
            lifecycleGenerationRef.current === generation &&
            !dialog.open
          ) {
            dialog.showModal();
          }
        });
      }}
      onClick={handleBackdropClick}
      onKeyDown={onKeyDown}
      {...aria}
    >
      {children}
    </dialog>
  );
}

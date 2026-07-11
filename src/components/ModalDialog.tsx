import {
  type MouseEvent,
  type KeyboardEventHandler,
  type ReactNode,
  useEffect,
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
  const expectedCloseRef = useRef(false);
  const openRef = useRef(open);
  const unmountingRef = useRef(false);
  openRef.current = open;

  useEffect(() => {
    ref.current?.setAttribute("closedby", dismissible ? "any" : "none");
  }, [dismissible]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      if (!dialog.contains(document.activeElement)) {
        const initial = dialog.querySelector<HTMLElement>("[autofocus]");
        (initial ?? dialog).focus();
      }
    } else if (!open && dialog.open) {
      expectedCloseRef.current = true;
      dialog.close();
    }
  }, [open]);

  useLayoutEffect(() => {
    const dialog = ref.current;
    return () => {
      unmountingRef.current = true;
      if (dialog?.open) {
        expectedCloseRef.current = true;
        dialog.close();
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
      tabIndex={-1}
      onCancel={(event) => {
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        if (dismissible) onDismiss();
      }}
      onClose={() => {
        if (expectedCloseRef.current) {
          expectedCloseRef.current = false;
          return;
        }
        if (!openRef.current || unmountingRef.current) return;
        if (dismissible) {
          onDismiss();
          return;
        }
        queueMicrotask(() => {
          const dialog = ref.current;
          if (
            dialog &&
            openRef.current &&
            !unmountingRef.current &&
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

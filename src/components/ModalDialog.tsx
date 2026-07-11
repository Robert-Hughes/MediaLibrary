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

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
      if (!dialog.contains(document.activeElement)) {
        const initial = dialog.querySelector<HTMLElement>("[autofocus]");
        (initial ?? dialog).focus();
      }
    } else if (!open && dialog.open) dialog.close();

    return () => {
      if (dialog.open) dialog.close();
    };
  }, [open]);

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
        event.preventDefault();
        if (dismissible) onDismiss();
      }}
      onClick={handleBackdropClick}
      onKeyDown={onKeyDown}
      {...aria}
    >
      {children}
    </dialog>
  );
}

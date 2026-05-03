import { useSpinnerSync } from "../hooks/useSpinnerSync";

interface Props {
  message: string;
}

export function StatusFooter({ message }: Props) {
  const spinRef = useSpinnerSync<HTMLSpanElement>();
  return (
    <div className="status-footer" data-testid="status-footer">
      <span ref={spinRef} className="status-footer-spinner" aria-hidden="true" />
      <span className="status-footer-message">{message}</span>
    </div>
  );
}

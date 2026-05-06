import { useSpinnerSync } from "../hooks/useSpinnerSync";

interface Props {
  message: string;
}

export function StatusFooter({ message }: Props) {
  const spinStyle = useSpinnerSync();
  return (
    <div className="status-footer" data-testid="status-footer">
      <span style={spinStyle} className="status-footer-spinner" aria-hidden="true" />
      <span className="status-footer-message">{message}</span>
    </div>
  );
}

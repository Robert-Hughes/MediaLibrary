interface Props {
  message: string;
}

/** App-level footer bar shown while background work is in progress. */
export function StatusFooter({ message }: Props) {
  return (
    <div className="status-footer" data-testid="status-footer">
      <span className="status-footer-spinner" aria-hidden="true" />
      <span className="status-footer-message">{message}</span>
    </div>
  );
}

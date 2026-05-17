interface Props {
  selectedCount: number;
  totalCount: number;
}

export function SelectionFooter({ selectedCount, totalCount }: Props) {
  const message = selectedCount === 0
    ? `${totalCount} ${totalCount === 1 ? "photo" : "photos"}`
    : `${selectedCount} of ${totalCount} selected`;
  return (
    <div className="selection-footer" data-testid="selection-footer">
      <span className="selection-footer-message">{message}</span>
    </div>
  );
}

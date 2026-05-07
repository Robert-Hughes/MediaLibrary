interface ResizeHandleProps {
  col: string;
  onResizeStart: (e: React.PointerEvent, col: string) => void;
  onResizeMove: (e: React.PointerEvent) => void;
  onResizeEnd: (e: React.PointerEvent) => void;
  onReset: (col: string) => void;
}

export function ResizeHandle({ col, onResizeStart, onResizeMove, onResizeEnd, onReset }: ResizeHandleProps) {
  return (
    <div
      className="resize-handle"
      draggable={false}
      data-testid={`resize-handle-${col}`}
      onPointerDown={(e) => onResizeStart(e, col)}
      onPointerMove={onResizeMove}
      onPointerUp={onResizeEnd}
      onPointerCancel={onResizeEnd}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => { e.stopPropagation(); onReset(col); }}
    />
  );
}

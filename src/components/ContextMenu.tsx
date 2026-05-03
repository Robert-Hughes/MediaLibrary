import { useEffect, useRef } from "react";

interface Props {
  x: number;
  y: number;
  options: Array<{
    label: string;
    onClick: () => void;
  }>;
  onClose: () => void;
}

export function ContextMenu({ x, y, options, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      data-testid="context-menu"
      style={{
        position: "fixed",
        top: y,
        left: x,
        zIndex: 1000,
      }}
    >
      <ul className="context-menu-list">
        {options.map((opt, i) => (
          <li key={i} className="context-menu-item">
            <button
              className="context-menu-btn"
              onClick={() => {
                opt.onClick();
                onClose();
              }}
            >
              {opt.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

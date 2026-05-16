import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Props {
  x: number;
  y: number;
  options: Array<{
    label: string;
    onClick: () => void;
    disabled?: boolean;
    title?: string;
  }>;
  onClose: () => void;
}

export function ContextMenu({ x, y, options, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  // Start where the cursor is, then nudge after layout if the menu would
  // overflow the viewport.  Position update happens in a layout effect
  // so the user never sees a clipped flash before the correction.
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: y, left: x });

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 4;
    let top = y;
    let left = x;
    if (left + width > vw - margin) {
      // Flip to the cursor's left side; clamp at 0 so an ultra-narrow
      // window can never push the menu fully off-screen.
      left = Math.max(margin, x - width);
    }
    if (top + height > vh - margin) {
      top = Math.max(margin, y - height);
    }
    if (top !== pos.top || left !== pos.left) {
      setPos({ top, left });
    }
  }, [x, y, options.length, pos.top, pos.left]);

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
        top: pos.top,
        left: pos.left,
        zIndex: 1000,
      }}
    >
      <ul className="context-menu-list">
        {options.map((opt, i) => (
          <li key={i} className="context-menu-item">
            <button
              className="context-menu-btn"
              onClick={() => {
                if (opt.disabled) return;
                opt.onClick();
                onClose();
              }}
              disabled={opt.disabled}
              title={opt.title}
            >
              {opt.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

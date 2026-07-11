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
  const previousFocus = useRef<HTMLElement | null>(null);
  // Start where the cursor is, then nudge after layout if the menu would
  // overflow the viewport.  Position update happens in a layout effect
  // so the user never sees a clipped flash before the correction.
  const [pos, setPos] = useState<{ top: number; left: number }>({
    top: y,
    left: x,
  });

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
    previousFocus.current = document.activeElement as HTMLElement | null;
    menuRef.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      previousFocus.current?.focus();
    };
  }, [onClose]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const enabled = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ) ?? [],
    );
    const current = enabled.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    let next: number | null = null;
    if (event.key === "Escape") onClose();
    else if (event.key === "ArrowDown") next = (current + 1) % enabled.length;
    else if (event.key === "ArrowUp")
      next = (current - 1 + enabled.length) % enabled.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = enabled.length - 1;
    else return;
    event.preventDefault();
    if (next !== null) enabled[next]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="context-menu"
      data-testid="context-menu"
      role="menu"
      onKeyDown={handleKeyDown}
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

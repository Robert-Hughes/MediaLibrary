import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../components/ContextMenu";
import { ModalDialog } from "../components/ModalDialog";

const options = [
  { label: "Disabled", disabled: true, onClick: vi.fn() },
  { label: "First", onClick: vi.fn() },
  { label: "Second", onClick: vi.fn() },
];

describe("ContextMenu keyboard and focus lifecycle", () => {
  it("uses native button roles and navigates enabled items", () => {
    render(<ContextMenu x={0} y={0} options={options} onClose={vi.fn()} />);
    const menu = document.querySelector(".context-menu-list")!;
    const items = screen.getAllByRole("button");
    expect(items).toHaveLength(3);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "End" });
    expect(items[2]).toHaveFocus();
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
  });

  it("uses the latest close callback without resetting focus on rerender", () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const { rerender } = render(
      <ContextMenu x={0} y={0} options={options} onClose={firstClose} />,
    );
    const menu = document.querySelector(".context-menu-list")!;
    fireEvent.keyDown(menu, { key: "End" });
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    rerender(
      <ContextMenu x={0} y={0} options={options} onClose={secondClose} />,
    );
    expect(screen.getByRole("button", { name: "Second" })).toHaveFocus();
    fireEvent.keyDown(document.querySelector(".context-menu-list")!, {
      key: "Escape",
    });
    expect(firstClose).not.toHaveBeenCalled();
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("handles no enabled items and restores focus on unmount", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(
      <ContextMenu
        x={0}
        y={0}
        options={[{ label: "Disabled", disabled: true, onClick: vi.fn() }]}
        onClose={vi.fn()}
      />,
    );
    expect(() =>
      fireEvent.keyDown(document.querySelector(".context-menu-list")!, {
        key: "ArrowDown",
      }),
    ).not.toThrow();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it("consumes Escape before a containing native dialog sees it", () => {
    const dismissDialog = vi.fn();
    const closeMenu = vi.fn();
    function Harness() {
      const [menuOpen, setMenuOpen] = useState(true);
      return (
        <ModalDialog open onDismiss={dismissDialog} aria-label="Gallery">
          {menuOpen && (
            <ContextMenu
              x={0}
              y={0}
              options={[{ label: "Action", onClick: vi.fn() }]}
              onClose={() => {
                closeMenu();
                setMenuOpen(false);
              }}
            />
          )}
        </ModalDialog>
      );
    }
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Action" }), {
      key: "Escape",
    });
    expect(closeMenu).toHaveBeenCalledOnce();
    expect(dismissDialog).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(dismissDialog).toHaveBeenCalledOnce();
  });
});

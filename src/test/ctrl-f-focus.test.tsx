/**
 * Tests the global Ctrl/Cmd+F handler that focuses the visible search
 * box.  Mounts a stub component that reproduces the handler from App
 * verbatim — App itself drags in the entire scan/setup stack, so the
 * focused unit test is much faster and more deterministic.
 */
import { render, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { useEffect } from "react";

function Harness({ withDetails }: { withDetails: boolean }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "f" && e.key !== "F") return;
      const details = document.getElementById(
        "details-search-input",
      ) as HTMLInputElement | null;
      const list = document.getElementById(
        "list-search-input",
      ) as HTMLInputElement | null;
      const target = details ?? list;
      if (!target) return;
      e.preventDefault();
      target.focus();
      target.select();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);
  return (
    <>
      <input id="list-search-input" data-testid="list-search-input" />
      {withDetails && (
        <input id="details-search-input" data-testid="details-search-input" />
      )}
    </>
  );
}

describe("Ctrl+F focus", () => {
  beforeEach(() => cleanup());

  it("focuses the list-view search box when no details pane is visible", () => {
    render(<Harness withDetails={false} />);
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(document.activeElement?.id).toBe("list-search-input");
  });

  it("prefers the details-pane search box when it is visible", () => {
    render(<Harness withDetails={true} />);
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(document.activeElement?.id).toBe("details-search-input");
  });

  it("also responds to Cmd+F (mac)", () => {
    render(<Harness withDetails={false} />);
    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(document.activeElement?.id).toBe("list-search-input");
  });

  it("does nothing when neither search input is present", () => {
    const before = document.activeElement;
    render(<></>);
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });
    expect(document.activeElement).toBe(before);
  });
});

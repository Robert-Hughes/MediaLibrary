import { useRef, useState } from "react";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRowSelection } from "../hooks/useRowSelection";

describe("refresh row selection", () => {
  function setup() {
    return renderHook(
      ({ paths, refreshing }) => {
        const [selectedPath, onSelect] = useState<string | null>("a.jpg");
        const listRef = useRef<HTMLDivElement>(null);
        return {
          selectedPath,
          ...useRowSelection({
            paths,
            selectedPath,
            onSelect,
            listRef,
            rowHeight: 44,
            onFileOpen: vi.fn(),
            preserveMissingPaths: refreshing,
          }),
        };
      },
      {
        initialProps: { paths: ["a.jpg", "b.jpg", "c.jpg"], refreshing: false },
      },
    );
  }

  it("retains a single selection and Shift anchor across empty, partial, and reordered results", () => {
    const { result, rerender } = setup();
    rerender({ paths: [], refreshing: true });
    expect(result.current.selectedPath).toBe("a.jpg");
    rerender({ paths: ["c.jpg"], refreshing: true });
    rerender({ paths: ["c.jpg", "a.jpg", "b.jpg"], refreshing: false });
    expect([...result.current.selectedIndices]).toEqual([1]);
    act(() => result.current.handleRowSelect(2, { ctrl: false, shift: true }));
    expect([...result.current.selectedIndices]).toEqual([1, 2]);
  });

  it("clears selection when the completed refresh contains no surviving files", () => {
    const { result, rerender } = setup();
    rerender({ paths: [], refreshing: true });
    rerender({ paths: [], refreshing: false });
    expect(result.current.selectedPath).toBeNull();
    expect(result.current.selectedIndices.size).toBe(0);
  });
});

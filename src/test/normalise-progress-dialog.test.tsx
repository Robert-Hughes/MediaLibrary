/**
 * Focused tests for the NormaliseProgressDialog component — phase
 * panels, per-group checkbox interaction, done-summary rendering.
 * Mocked Tauri APIs not needed because the component is dumb (state
 * + callbacks supplied as props).
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { NormaliseProgressDialog } from "../components/NormaliseProgressDialog";
import type { NormaliseProgressState } from "../hooks/useNormaliseMetadata";
import type { NormaliseGroup, NormaliseSummary } from "../types";

const allGroups: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "headline",
  "title",
  "location",
  "dates",
];

function baseState(over: Partial<NormaliseProgressState> = {}): NormaliseProgressState {
  return {
    phase: "awaiting-confirm",
    total: 1,
    current: 0,
    currentFile: null,
    cancelling: false,
    failures: [],
    succeeded: [],
    summary: null,
    items: [],
    enabledGroups: [...allGroups],
    ...over,
  };
}

describe("NormaliseProgressDialog — awaiting-confirm", () => {
  it("renders one checkbox per v1 group, all checked by default", () => {
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    for (const g of allGroups) {
      const cb = screen.getByTestId(`normalise-group-${g}-checkbox`) as HTMLInputElement;
      expect(cb.checked).toBe(true);
    }
  });

  it("toggling a checkbox calls onSetEnabledGroups with the new set", () => {
    const onSet = vi.fn();
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={onSet}
      />,
    );
    fireEvent.click(screen.getByTestId("normalise-group-keywords-checkbox"));
    expect(onSet).toHaveBeenCalledTimes(1);
    expect(onSet.mock.calls[0][0]).not.toContain("keywords");
    // Other six groups are preserved in canonical order.
    expect(onSet.mock.calls[0][0]).toEqual([
      "creator", "copyright", "headline", "title", "location", "dates",
    ]);
  });

  it("toggling back on re-adds the group in canonical order", () => {
    const onSet = vi.fn();
    render(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: ["creator", "copyright"] })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={onSet}
      />,
    );
    fireEvent.click(screen.getByTestId("normalise-group-keywords-checkbox"));
    expect(onSet.mock.calls[0][0]).toEqual(["keywords", "creator", "copyright"]);
  });

  it("confirm button is disabled when no groups are enabled", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: [] })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const btn = screen.getByTestId("normalise-confirm-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("confirm button enabled when ≥1 group", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: ["keywords"] })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const btn = screen.getByTestId("normalise-confirm-btn") as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("Confirm callback fires when button clicked", () => {
    const onConfirm = vi.fn();
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={onConfirm}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("normalise-confirm-btn"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("Cancel callback fires when cancel button clicked", () => {
    const onCancel = vi.fn();
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={onCancel}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("normalise-cancel-btn"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the prominent overwrite warning", () => {
    const { container } = render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(container.textContent).toMatch(/will be overwritten/i);
    expect(container.textContent).toMatch(/will be cleared/i);
  });
});

describe("NormaliseProgressDialog — running", () => {
  it("renders progress bar with current / total", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ phase: "running", current: 2, total: 5, currentFile: "x.jpg" })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.getByTestId("normalise-count")).toHaveTextContent(/2 of 5/);
  });

  it("title swaps to Cancelling… when cancelling flag set", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ phase: "running", cancelling: true })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    // "Cancelling…" appears in both the title and the cancel button.
    expect(screen.getAllByText("Cancelling…").length).toBeGreaterThanOrEqual(1);
  });
});

describe("NormaliseProgressDialog — done", () => {
  function summary(over: Partial<NormaliseSummary> = {}): NormaliseSummary {
    return {
      nSucceeded: 0,
      nFailed: 0,
      nSkippedAllNormalised: 0,
      nGroupsNormalisedTotal: 0,
      nGroupsNoopTotal: 0,
      nLocationXmpIimConflictTotal: 0,
      nDateConflictTotal: 0,
      nDtoFromFilenameTotal: 0,
      nDtoFromFilenameDateOnlyTotal: 0,
      nUnparseableDateInputsTotal: 0,
      ...over,
    };
  }

  it("renders 'Completed: K / N images' with summary breakdown", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 3,
          succeeded: ["a.jpg", "b.jpg", "c.jpg"],
          summary: summary({ nSucceeded: 3, nGroupsNormalisedTotal: 5, nGroupsNoopTotal: 16 }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const sumDom = screen.getByTestId("normalise-done-summary");
    expect(sumDom).toHaveTextContent(/3.*\/.*3/);
    const breakdown = screen.getByTestId("normalise-summary-breakdown");
    expect(breakdown).toHaveTextContent(/Groups normalised: 5/);
    expect(breakdown).toHaveTextContent(/Groups skipped.*16/);
  });

  it("hides zero-value counters in the breakdown second row", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 1,
          succeeded: ["a.jpg"],
          summary: summary({ nSucceeded: 1, nGroupsNormalisedTotal: 1 }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const breakdown = screen.getByTestId("normalise-summary-breakdown");
    expect(breakdown).not.toHaveTextContent(/Date conflicts/);
    expect(breakdown).not.toHaveTextContent(/DTO from filename/);
  });

  it("surfaces filename-fallback counters when non-zero", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 2,
          succeeded: ["a.jpg", "b.jpg"],
          summary: summary({
            nSucceeded: 2,
            nDtoFromFilenameTotal: 1,
            nDtoFromFilenameDateOnlyTotal: 1,
          }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const breakdown = screen.getByTestId("normalise-summary-breakdown");
    expect(breakdown).toHaveTextContent(/DTO from filename: 1/);
    expect(breakdown).toHaveTextContent(/DTO from filename \(date only\): 1/);
  });

  it("renders failure list when failures present", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 2,
          succeeded: ["a.jpg"],
          failures: [
            { relativePath: "b.jpg", kind: "command_failed", detail: "boom" },
          ],
          summary: summary({ nSucceeded: 1, nFailed: 1 }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.getByTestId("normalise-failure-list")).toHaveTextContent(/b\.jpg/);
  });

  it("Close button fires onClose", () => {
    const onClose = vi.fn();
    render(
      <NormaliseProgressDialog
        state={baseState({ phase: "done", succeeded: [], summary: summary() })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={onClose}
        onSetEnabledGroups={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId("normalise-close-btn"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

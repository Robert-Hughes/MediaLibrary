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
import type { NormaliseGroup, NormalisePerGroupStats, NormaliseSummary } from "../types";

const allGroups: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "headline",
  "title",
  "location",
  "dates",
  "description",
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
    estimate: null,
    estimateError: null,
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
    // Remaining groups preserved in canonical order.
    expect(onSet.mock.calls[0][0]).toEqual([
      "creator", "copyright", "headline", "title", "location", "dates", "description",
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

  it("shows the prominent overwrite warning (fallback when no overwriteInfo provided)", () => {
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

  it("renders the inline overwrite notice when overwriteInfo has existing > 0", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ total: 3 })}
        overwriteInfo={{ existingCount: 2, totalCount: 3 }}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const notice = screen.getByTestId("normalise-overwrite-notice");
    expect(notice).toHaveTextContent(/Overwrite metadata fields\?/);
    expect(notice).toHaveTextContent(/2 of 3 selected images already have/i);
    expect(notice).toHaveTextContent(/fields outside the canonical form will be cleared/i);
  });

  it("renders no overwrite notice when overwriteInfo has existing === 0", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ total: 3 })}
        overwriteInfo={{ existingCount: 0, totalCount: 3 }}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.queryByTestId("normalise-overwrite-notice")).toBeNull();
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
      perGroup: {},
      aiCostTotalUsd: 0,
      aiCallsTotal: 0,
      ...over,
    };
  }

  function pg(over: Partial<NormalisePerGroupStats> = {}): NormalisePerGroupStats {
    return {
      nNoop: 0,
      nNormalisedDeterministic: 0,
      nNormalisedAi: 0,
      nConflictPrimaryWon: 0,
      nLocationXmpIimConflict: 0,
      nDateConflict: 0,
      nDtoFromFilename: 0,
      nDtoFromFilenameDateOnly: 0,
      nUnparseableDateInputs: 0,
      nAiErrors: 0,
      ...over,
    };
  }

  it("renders 'Completed: K / N images' with per-group summary", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 3,
          succeeded: ["a.jpg", "b.jpg", "c.jpg"],
          summary: summary({
            nSucceeded: 3,
            perGroup: {
              keywords: pg({ nNormalisedDeterministic: 2, nNoop: 1 }),
              creator: pg({ nNoop: 3 }),
              dates: pg({ nNormalisedDeterministic: 3 }),
            },
          }),
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
    // Aggregate row.
    expect(breakdown).toHaveTextContent(/Groups normalised \(deterministic\): 5/);
    expect(breakdown).toHaveTextContent(/Groups skipped.*4/);
    // Per-group rows for each visited group.
    expect(screen.getByTestId("normalise-group-summary-keywords")).toHaveTextContent(/2 normalised/);
    expect(screen.getByTestId("normalise-group-summary-keywords")).toHaveTextContent(/1 no-op/);
    expect(screen.getByTestId("normalise-group-summary-creator")).toHaveTextContent(/3 no-op/);
    expect(screen.getByTestId("normalise-group-summary-dates")).toHaveTextContent(/3 normalised/);
  });

  it("omits per-group rows for groups the dispatcher never visited", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 1,
          succeeded: ["a.jpg"],
          summary: summary({
            nSucceeded: 1,
            perGroup: { keywords: pg({ nNormalisedDeterministic: 1 }) },
          }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.queryByTestId("normalise-group-summary-creator")).toBeNull();
    expect(screen.queryByTestId("normalise-group-summary-dates")).toBeNull();
    expect(screen.getByTestId("normalise-group-summary-keywords")).toBeInTheDocument();
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
            perGroup: {
              dates: pg({
                nNormalisedDeterministic: 2,
                nDtoFromFilename: 1,
                nDtoFromFilenameDateOnly: 1,
              }),
            },
          }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const datesRow = screen.getByTestId("normalise-group-summary-dates");
    expect(datesRow).toHaveTextContent(/1 DTO from filename/);
    expect(datesRow).toHaveTextContent(/1 DTO date-only fallback/);
  });

  it("renders AI calls + cost row when AI fired", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({
          phase: "done",
          total: 2,
          succeeded: ["a.jpg", "b.jpg"],
          summary: summary({
            nSucceeded: 2,
            aiCallsTotal: 3,
            aiCostTotalUsd: 0.00123,
            perGroup: {
              description: pg({ nNormalisedAi: 2 }),
            },
          }),
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const breakdown = screen.getByTestId("normalise-summary-breakdown");
    expect(breakdown).toHaveTextContent(/AI calls: 3/);
    expect(breakdown).toHaveTextContent(/\$0\.0012/);
    expect(breakdown).toHaveTextContent(/Groups normalised \(AI\): 2/);
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

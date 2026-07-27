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
import type {
  NormaliseEstimate,
  NormaliseGroup,
  NormaliseGroupOutcomeCounts,
  NormalisePerGroupStats,
  NormaliseSummary,
} from "../types";

const allGroups: NormaliseGroup[] = [
  "keywords",
  "creator",
  "copyright",
  "iptc_utf8",
  "location",
  "dates",
  "description",
  "title",
  "headline",
];

/**
 * Build an estimate where every group has at least one non-noop
 * outcome so the per-group rows are enabled by default. Tests that
 * need a specific outcome distribution pass `perGroupOutcomes` to
 * override.
 */
function mockEstimate(
  over: Partial<NormaliseEstimate> = {},
): NormaliseEstimate {
  const allActive: NormaliseGroupOutcomeCounts = {
    nNoop: 0,
    nNormalisedDeterministic: 1,
    nNormalisedAi: 0,
    nConflict: 0,
    nOverwrites: 0,
  };
  return {
    nImagesWithAiB: 0,
    nImagesWithAiC: 0,
    nImagesWithAiG: 0,
    nImagesNoAi: 1,
    totalInputTokens: 0,
    predictedCostUsd: 0,
    upperBoundCostUsd: 0,
    model: "",
    locationModel: "",
    perGroupOutcomes: {
      keywords: { ...allActive },
      creator: { ...allActive },
      copyright: { ...allActive },
      iptc_utf8: { ...allActive },
      headline: { ...allActive },
      title: { ...allActive, nNormalisedAi: 1, nNormalisedDeterministic: 0 },
      location: { ...allActive },
      dates: { ...allActive },
      description: {
        ...allActive,
        nNormalisedAi: 1,
        nNormalisedDeterministic: 0,
      },
    },
    iptcUtf8BaseApplicablePaths: ["a.jpg"],
    iptcUtf8OutputPathsByGroup: {},
    aiTokenBreakdown: null,
    pricing: null,
    locationPricing: null,
    expectedOutPerCallB: 250,
    maxOutPerCallB: 400,
    expectedOutPerCallC: 15,
    maxOutPerCallC: 30,
    expectedOutPerCallG: 100,
    maxOutPerCallG: 250,
    ...over,
  };
}

function baseState(
  over: Partial<NormaliseProgressState> = {},
): NormaliseProgressState {
  return {
    phase: "awaiting-confirm",
    total: 1,
    current: 0,
    currentFile: null,
    cancelling: false,
    failures: [],
    succeeded: [],
    summary: null,
    estimate: mockEstimate(),
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
      const cb = screen.getByTestId(
        `normalise-group-${g}-checkbox`,
      ) as HTMLInputElement;
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
    // Remaining groups preserved in canonical (execution) order.
    expect(onSet.mock.calls[0][0]).toEqual([
      "creator",
      "copyright",
      "iptc_utf8",
      "location",
      "dates",
      "description",
      "title",
      "headline",
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
    expect(onSet.mock.calls[0][0]).toEqual([
      "keywords",
      "creator",
      "copyright",
    ]);
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
    const btn = screen.getByTestId(
      "normalise-confirm-btn",
    ) as HTMLButtonElement;
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
    const btn = screen.getByTestId(
      "normalise-confirm-btn",
    ) as HTMLButtonElement;
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

  it("renders outcome table with cells from estimate.perGroupOutcomes", () => {
    const est = mockEstimate({
      perGroupOutcomes: {
        keywords: {
          nNoop: 5,
          nNormalisedDeterministic: 3,
          nNormalisedAi: 0,
          nConflict: 0,
          nOverwrites: 0,
        },
        dates: {
          nNoop: 6,
          nNormalisedDeterministic: 1,
          nNormalisedAi: 0,
          nConflict: 1,
          nOverwrites: 2,
        },
        description: {
          nNoop: 2,
          nNormalisedDeterministic: 0,
          nNormalisedAi: 6,
          nConflict: 0,
          nOverwrites: 9,
        },
      },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ total: 8, estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(
      screen.getByTestId("normalise-group-keywords-noop"),
    ).toHaveTextContent("5");
    expect(
      screen.getByTestId("normalise-group-keywords-deterministic"),
    ).toHaveTextContent("3");
    expect(screen.getByTestId("normalise-group-keywords-ai")).toHaveTextContent(
      "—",
    );
    expect(
      screen.getByTestId("normalise-group-description-ai"),
    ).toHaveTextContent("6");
    expect(
      screen.getByTestId("normalise-group-dates-conflict"),
    ).toHaveTextContent("1");
    expect(
      screen.getByTestId("normalise-group-dates-overwrites"),
    ).toHaveTextContent("2");
    expect(
      screen.getByTestId("normalise-group-description-overwrites"),
    ).toHaveTextContent("9");
  });

  it("overwrites cell is bold/warning when non-zero", () => {
    const est = mockEstimate({
      perGroupOutcomes: {
        creator: {
          nNoop: 0,
          nNormalisedDeterministic: 5,
          nNormalisedAi: 0,
          nConflict: 0,
          nOverwrites: 3,
        },
      },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const cell = screen.getByTestId("normalise-group-creator-overwrites");
    expect(cell).toHaveStyle({ fontWeight: "600" });
  });

  it("conflict cell is red when non-zero", () => {
    const est = mockEstimate({
      perGroupOutcomes: {
        location: {
          nNoop: 0,
          nNormalisedDeterministic: 2,
          nNormalisedAi: 0,
          nConflict: 2,
          nOverwrites: 0,
        },
      },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const cell = screen.getByTestId("normalise-group-location-conflict");
    expect(cell).toHaveStyle({ color: "var(--accent-error, #d33)" });
  });

  it("auto-disables rows where every image is a no-op", () => {
    const est = mockEstimate({
      perGroupOutcomes: {
        keywords: {
          nNoop: 10,
          nNormalisedDeterministic: 0,
          nNormalisedAi: 0,
          nConflict: 0,
          nOverwrites: 0,
        },
      },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ total: 10, estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const cb = screen.getByTestId(
      "normalise-group-keywords-checkbox",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(cb.checked).toBe(false);
  });

  it("enables IPTC UTF-8 when a selected group prospectively creates IPTC", () => {
    const est = mockEstimate({
      perGroupOutcomes: {
        keywords: {
          nNoop: 0,
          nNormalisedDeterministic: 1,
          nNormalisedAi: 0,
          nConflict: 0,
          nOverwrites: 0,
        },
        iptc_utf8: {
          nNoop: 1,
          nNormalisedDeterministic: 0,
          nNormalisedAi: 0,
          nConflict: 0,
          nOverwrites: 0,
        },
      },
      iptcUtf8BaseApplicablePaths: [],
      iptcUtf8OutputPathsByGroup: { keywords: ["new-iptc.jpg"] },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({
          enabledGroups: ["keywords", "iptc_utf8"],
          estimate: est,
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );

    const cb = screen.getByTestId(
      "normalise-group-iptc_utf8-checkbox",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(false);
    expect(cb.checked).toBe(true);
    expect(
      screen.getByTestId("normalise-group-iptc_utf8-deterministic"),
    ).toHaveTextContent("1");
  });

  it("disables IPTC UTF-8 when no selected output needs it, including effective UTF-8", () => {
    const est = mockEstimate({
      iptcUtf8BaseApplicablePaths: [],
      iptcUtf8OutputPathsByGroup: {},
    });
    render(
      <NormaliseProgressDialog
        state={baseState({
          enabledGroups: ["iptc_utf8"],
          estimate: est,
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );

    const cb = screen.getByTestId(
      "normalise-group-iptc_utf8-checkbox",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(cb.checked).toBe(false);
  });

  it("removes IPTC UTF-8 when the last prospective producer is unchecked", () => {
    const onSet = vi.fn();
    const est = mockEstimate({
      iptcUtf8BaseApplicablePaths: [],
      iptcUtf8OutputPathsByGroup: { keywords: ["new-iptc.jpg"] },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({
          enabledGroups: ["keywords", "iptc_utf8"],
          estimate: est,
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={onSet}
      />,
    );

    fireEvent.click(screen.getByTestId("normalise-group-keywords-checkbox"));
    expect(onSet).toHaveBeenLastCalledWith([]);
  });

  it("keeps an explicit IPTC UTF-8 opt-out when applicability returns", () => {
    const onSet = vi.fn();
    const est = mockEstimate({
      iptcUtf8BaseApplicablePaths: [],
      iptcUtf8OutputPathsByGroup: {
        keywords: ["new-iptc.jpg"],
        description: ["new-iptc.jpg"],
      },
    });
    const props = {
      onConfirm: () => {},
      onCancel: () => {},
      onClose: () => {},
      onSetEnabledGroups: onSet,
    };
    const { rerender } = render(
      <NormaliseProgressDialog
        state={baseState({
          enabledGroups: ["keywords", "iptc_utf8"],
          estimate: est,
        })}
        {...props}
      />,
    );

    fireEvent.click(screen.getByTestId("normalise-group-iptc_utf8-checkbox"));
    expect(onSet).toHaveBeenLastCalledWith(["keywords"]);

    rerender(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: [], estimate: est })}
        {...props}
      />,
    );
    fireEvent.click(screen.getByTestId("normalise-group-description-checkbox"));
    expect(onSet).toHaveBeenLastCalledWith(["description"]);
  });

  it("keeps Description enabled when all targets are empty but AI context exists (nNormalisedAi > 0)", () => {
    const est = mockEstimate({
      perGroupOutcomes: {
        description: {
          nNoop: 0,
          nNormalisedDeterministic: 0,
          nNormalisedAi: 1,
          nConflict: 0,
          nOverwrites: 0,
        },
      },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ total: 1, estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const cb = screen.getByTestId(
      "normalise-group-description-checkbox",
    ) as HTMLInputElement;
    expect(cb.disabled).toBe(false);
    expect(cb.checked).toBe(true);
  });

  it("cost preview adapts to selection — toggling description off removes its cost", () => {
    const est = mockEstimate({
      nImagesWithAiB: 4,
      nImagesWithAiC: 0,
      aiTokenBreakdown: {
        descriptionInputTokens: 4000,
        titleInputTokens: 0,
        locationInputTokens: 0,
        descriptionCallCount: 4,
        titleCallCount: 0,
        locationCallCount: 0,
      },
      pricing: { inputPer1M: 1.0, outputPer1M: 4.0 },
      model: "gpt-test",
    });
    const { rerender } = render(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: [...allGroups], estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.getByTestId("normalise-cost-preview")).toHaveTextContent(
      /4 description AI calls/,
    );
    rerender(
      <NormaliseProgressDialog
        state={baseState({
          enabledGroups: allGroups.filter((g) => g !== "description"),
          estimate: est,
        })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.getByTestId("normalise-cost-preview")).toHaveTextContent(
      /No AI calls required/,
    );
  });

  it("prices location calls with the separately configured model", () => {
    const est = mockEstimate({
      nImagesWithAiG: 2,
      locationModel: "gpt-location-test",
      aiTokenBreakdown: {
        descriptionInputTokens: 0,
        titleInputTokens: 0,
        locationInputTokens: 2000,
        descriptionCallCount: 0,
        titleCallCount: 0,
        locationCallCount: 2,
      },
      locationPricing: { inputPer1M: 1.0, outputPer1M: 4.0 },
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: ["location"], estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const preview = screen.getByTestId("normalise-cost-preview");
    expect(preview).toHaveTextContent(/2 location resolutions/);
    expect(preview).toHaveTextContent(/gpt-location-test/);
  });

  it("cost preview shows missing-key notice when AI rows selected but no pricing", () => {
    const est = mockEstimate({
      nImagesWithAiB: 3,
      nImagesWithAiC: 0,
      aiTokenBreakdown: null,
      pricing: null,
    });
    render(
      <NormaliseProgressDialog
        state={baseState({ enabledGroups: [...allGroups], estimate: est })}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(screen.getByTestId("normalise-cost-preview")).toHaveTextContent(
      /no OpenAI key is configured/i,
    );
  });

  it("group labels are bare (no parenthetical hints) and carry tooltips", () => {
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const datesLabel = screen.getByTestId("normalise-group-dates-label");
    expect(datesLabel).toHaveTextContent(/^Dates$/);
    expect(datesLabel.getAttribute("title")).toMatch(
      /ExifIFD:DateTimeOriginal/,
    );
    const locLabel = screen.getByTestId("normalise-group-location-label");
    expect(locLabel).toHaveTextContent(/^Location$/);
    expect(locLabel.getAttribute("title")).toMatch(/XMP-iptcCore:Location/);
    const descLabel = screen.getByTestId("normalise-group-description-label");
    expect(descLabel).toHaveTextContent(/^Description$/);
    expect(descLabel.getAttribute("title")).toMatch(/AI/);
    const kwLabel = screen.getByTestId("normalise-group-keywords-label");
    expect(kwLabel.getAttribute("title")).toMatch(/XMP-mlib:AITags/);
  });

  it("Description tooltip includes correct read-only inputs and empty + AI context regeneration behavior", () => {
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const descLabel = screen.getByTestId("normalise-group-description-label");
    const titleAttr = descLabel.getAttribute("title") || "";
    expect(titleAttr).toMatch(/XMP-mlib:AIDescription/);
    expect(titleAttr).toMatch(/XMP-mlib:AIInterpretation/);
    expect(titleAttr).toMatch(/XMP-mlib:AIOcrText/);
    expect(titleAttr).toMatch(/XMP-mlib:AIObjects/);
    expect(titleAttr).toMatch(
      /generate from AI context when targets are empty/,
    );
  });

  it("Title tooltip describes generating from description when title targets are empty and newly regenerated description usage", () => {
    render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    const titleLabel = screen.getByTestId("normalise-group-title-label");
    const titleAttr = titleLabel.getAttribute("title") || "";
    expect(titleAttr).toMatch(
      /If both title targets are empty and Description canonical is available \(including newly regenerated Description\), calls AI to generate a short title/,
    );
  });

  it("description label no longer mentions API key requirement", () => {
    const { container } = render(
      <NormaliseProgressDialog
        state={baseState()}
        onConfirm={() => {}}
        onCancel={() => {}}
        onClose={() => {}}
        onSetEnabledGroups={() => {}}
      />,
    );
    expect(container.textContent).not.toMatch(/needs OpenAI key/i);
    expect(container.textContent).not.toMatch(/requires API key/i);
  });

  it("no longer renders the legacy overwrite-notice panel", () => {
    render(
      <NormaliseProgressDialog
        state={baseState({ total: 3 })}
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
        state={baseState({
          phase: "running",
          current: 2,
          total: 5,
          currentFile: "x.jpg",
        })}
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

  function pg(
    over: Partial<NormalisePerGroupStats> = {},
  ): NormalisePerGroupStats {
    return {
      nNoop: 0,
      nNormalisedDeterministic: 0,
      nNormalisedAi: 0,
      nConflictPrimaryWon: 0,
      nLocationXmpIimConflict: 0,
      nLocationCreatedAmbiguous: 0,
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
    expect(breakdown).toHaveTextContent(
      /Groups normalised \(deterministic\): 5/,
    );
    expect(breakdown).toHaveTextContent(/Groups skipped.*4/);
    // Per-group rows for each visited group.
    expect(
      screen.getByTestId("normalise-group-summary-keywords"),
    ).toHaveTextContent(/2 normalised/);
    expect(
      screen.getByTestId("normalise-group-summary-keywords"),
    ).toHaveTextContent(/1 no-op/);
    expect(
      screen.getByTestId("normalise-group-summary-creator"),
    ).toHaveTextContent(/3 no-op/);
    expect(
      screen.getByTestId("normalise-group-summary-dates"),
    ).toHaveTextContent(/3 normalised/);
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
    expect(
      screen.getByTestId("normalise-group-summary-keywords"),
    ).toBeInTheDocument();
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
    expect(screen.getByTestId("normalise-failure-list")).toHaveTextContent(
      /b\.jpg/,
    );
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

/**
 * End-to-end tests for the AI image-description UI flow.
 *
 * Asserts the DescribeProgressDialog phase machine, the settings dialog
 * round-trip, and the DetailsPane button trigger. Backend is mocked at the
 * Tauri-invoke boundary; events are dispatched synchronously by the mock
 * so we can observe state transitions in the order the real backend would.
 */
import {
  render,
  screen,
  act,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { DESCRIBE_TARGET_TAGS } from "../generatedTargetDrafts";
import { createMockTauriApi } from "./mockTauriApi";
import { makeFile, mockGeneratedDraftEntries } from "./factories";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) =>
    mockApiInstance.api.invoke(cmd, args),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (evt: string, handler: (event: { payload: unknown }) => void) =>
    mockApiInstance.api.listen(evt, (payload: unknown) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

async function openFolderWithFile(rel = "test.jpg") {
  const file = makeFile({ relative_path: rel });
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/files");
  render(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  await user.click(screen.getByTestId("open-folder-btn"));
  await act(async () => {
    mockApiInstance.emitFileFound(file);
  });
  await act(async () => {
    mockApiInstance.emitScanComplete();
  });
  // DetailsPane only renders its action buttons once metadata has loaded.
  // Emit an empty-but-present record so we leave the "loading" state.
  await act(async () => {
    mockApiInstance.emitFileMetadataReady(rel, {});
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 250));
  });
  return { user, file };
}

beforeEach(() => {
  mockApiInstance = createMockTauriApi();
  mockApiInstance.tagInfos = DESCRIBE_TARGET_TAGS.map((id) => ({
    id: structuredClone(id),
    group: "XMP-mlib",
    name: id.tag_id,
    writable: true,
    kind: { kind: "Text" },
    description: null,
  }));
});
afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("SettingsDialog", () => {
  it("loads stored API key and model on open, and persists edits", async () => {
    mockApiInstance.settings = {
      openai_api_key: "sk-existing",
      openai_model: "gpt-5.4",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "exact",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    const { user } = await openFolderWithFile();

    await user.click(screen.getByTestId("menu-bar-settings-btn"));
    const apiKeyInput = await screen.findByTestId("settings-api-key-input");
    // The input is type=password so we assert .value rather than visible text.
    await waitFor(() =>
      expect((apiKeyInput as HTMLInputElement).value).toBe("sk-existing"),
    );

    const modelSelect = screen.getByTestId(
      "settings-model-select",
    ) as HTMLSelectElement;
    expect(modelSelect.value).toBe("gpt-5.4");
    const estimateModeSelect = screen.getByTestId(
      "settings-ai-cost-estimate-mode-select",
    ) as HTMLSelectElement;
    const locationModelSelect = screen.getByTestId(
      "settings-normalise-location-model-select",
    ) as HTMLSelectElement;
    expect(locationModelSelect.value).toBe("gpt-5.4-nano");
    expect(estimateModeSelect.value).toBe("exact");
    const describeConcurrencySelect = screen.getByTestId(
      "settings-describe-concurrency-select",
    ) as HTMLSelectElement;
    const metadataConcurrencySelect = screen.getByTestId(
      "settings-metadata-scan-concurrency-select",
    ) as HTMLSelectElement;
    const metadataBatchSizeSelect = screen.getByTestId(
      "settings-metadata-scan-batch-size-select",
    ) as HTMLSelectElement;
    const metadataApplyBatchSizeSelect = screen.getByTestId(
      "settings-metadata-apply-batch-size-select",
    ) as HTMLSelectElement;
    const metadataApplyConcurrencySelect = screen.getByTestId(
      "settings-metadata-apply-concurrency-select",
    ) as HTMLSelectElement;
    const thumbnailConcurrencySelect = screen.getByTestId(
      "settings-thumbnail-concurrency-select",
    ) as HTMLSelectElement;
    expect(describeConcurrencySelect.value).toBe("6");
    expect(
      within(describeConcurrencySelect).getByRole("option", {
        name: "12 (recommended)",
      }),
    ).toHaveValue("12");
    expect(metadataConcurrencySelect.value).toBe("4");
    expect(metadataBatchSizeSelect.value).toBe("20");
    expect(metadataApplyBatchSizeSelect.value).toBe("8");
    expect(metadataApplyConcurrencySelect.value).toBe("4");
    expect(
      within(metadataApplyBatchSizeSelect).getByRole("option", {
        name: "32 (recommended)",
      }),
    ).toHaveValue("32");
    expect(
      within(metadataApplyConcurrencySelect).getByRole("option", {
        name: "8 (recommended)",
      }),
    ).toHaveValue("8");
    expect(thumbnailConcurrencySelect.value).toBe("8");

    // Type into the API key input and tab away to commit the save.
    await user.clear(apiKeyInput);
    await user.type(apiKeyInput, "sk-new");
    fireEvent.blur(apiKeyInput);
    // Allow the async save_settings_cmd to settle.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockApiInstance.settings.openai_api_key).toBe("sk-new");

    // Switching the model selector saves immediately on change.
    await user.selectOptions(modelSelect, "gpt-4o");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockApiInstance.settings.openai_model).toBe("gpt-4o");

    await user.selectOptions(locationModelSelect, "gpt-4o");
    await waitFor(() =>
      expect(mockApiInstance.settings.normalise_location_model).toBe("gpt-4o"),
    );

    await user.selectOptions(estimateModeSelect, "heuristic");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(mockApiInstance.settings.ai_cost_estimate_mode).toBe("heuristic");

    await user.selectOptions(describeConcurrencySelect, "9");
    await waitFor(() =>
      expect(mockApiInstance.settings.describe_concurrency).toBe(9),
    );
    await user.selectOptions(metadataConcurrencySelect, "3");
    await waitFor(() =>
      expect(mockApiInstance.settings.metadata_scan_concurrency).toBe(3),
    );
    await user.selectOptions(metadataBatchSizeSelect, "50");
    await waitFor(() =>
      expect(mockApiInstance.settings.metadata_scan_batch_size).toBe(50),
    );
    await user.selectOptions(metadataApplyBatchSizeSelect, "16");
    await waitFor(() =>
      expect(mockApiInstance.settings.metadata_apply_batch_size).toBe(16),
    );
    await user.selectOptions(metadataApplyConcurrencySelect, "6");
    await waitFor(() =>
      expect(mockApiInstance.settings.metadata_apply_concurrency).toBe(6),
    );
    await user.selectOptions(thumbnailConcurrencySelect, "12");
    await waitFor(() =>
      expect(mockApiInstance.settings.thumbnail_concurrency).toBe(12),
    );
  });

  it("renders per-image cost beside each model in the dropdown", async () => {
    // User feedback: the bare model id told users nothing about cost.
    // Each option now ships its own ballpark estimate so the choice has
    // dollar-scale context at the point of decision.
    mockApiInstance.perImageCosts = {
      "gpt-4o": 0.00525,
      "gpt-5.4-nano": 0.00053,
    };
    mockApiInstance.recommendedModels = ["gpt-4o", "gpt-5.4-nano"];
    const { user } = await openFolderWithFile();
    await user.click(screen.getByTestId("menu-bar-settings-btn"));
    const select = (await screen.findByTestId(
      "settings-model-select",
    )) as HTMLSelectElement;
    await waitFor(() => {
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(
        labels.some(
          (l) => l && l.includes("gpt-4o") && l.includes("per image"),
        ),
      ).toBe(true);
      expect(
        labels.some(
          (l) => l && l.includes("gpt-5.4-nano") && /\$0\.000\d/.test(l),
        ),
      ).toBe(true);
    });
  });

  it("warning text near the API key field is visible (replaces consent dialog)", async () => {
    await openFolderWithFile();
    const { user } = { user: userEvent.setup() };
    await user.click(screen.getByTestId("menu-bar-settings-btn"));
    await screen.findByTestId("settings-api-key-input");
    expect(
      screen.getByText(/uploads selected images to OpenAI/i),
    ).toBeInTheDocument();
  });
});

describe("AI-description flow", () => {
  /**
   * Open the gallery's details pane and click the Generate AI Description
   * button. Returns the user-event session so callers can drive the dialog.
   */
  async function startAiDescription(rel = "test.jpg") {
    const { user, file } = await openFolderWithFile(rel);
    const row = screen.getByTestId("file-row");
    await user.dblClick(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const detailsToggle = screen.getByTestId("gallery-info-toggle");
    await user.click(detailsToggle);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const aiBtn = await screen.findByTestId("details-pane-generate-ai-btn");
    return { user, file, aiBtn };
  }

  it("walks through estimating → awaiting-confirm → running → done", async () => {
    mockApiInstance.settings = {
      openai_api_key: "sk-test",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    mockApiInstance.describeEstimateComplete = {
      totalInputTokens: 1234,
      predictedCostUsd: 0.0042,
      upperBoundCostUsd: 0.0099,
      model: "gpt-4o",
      estimateMode: "heuristic",
    };
    mockApiInstance.describeUsageSummary = {
      totalInputTokens: 1230,
      totalCachedTokens: 0,
      totalCacheWriteTokens: 0,
      totalOutputTokens: 200,
      totalReasoningTokens: 0,
      totalNonReasoningOutputTokens: 200,
      serviceTier: "default",
      reasoningEffort: "",
      predictedCostUsd: 0.0042,
      actualCostUsd: 0.005,
    };

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Dialog appears, walks straight through estimating (mock emits all
    // events synchronously) and into awaiting-confirm.
    await screen.findByTestId("describe-progress-dialog");
    const confirmBtn = await screen.findByTestId("describe-confirm-btn");
    expect(screen.getByTestId("describe-confirm-summary")).toHaveTextContent(
      /gpt-4o/,
    );

    await user.click(confirmBtn);

    // After confirm, the mock immediately emits started/progress/complete,
    // landing the dialog in the done phase with the usage summary visible.
    await screen.findByTestId("describe-done-summary");
    expect(screen.getByTestId("describe-usage-summary")).toHaveTextContent(
      /Actual:/,
    );

    // Close cleans up the dialog.
    await user.click(screen.getByTestId("describe-close-btn"));
    await waitFor(() => {
      expect(
        screen.queryByTestId("describe-progress-dialog"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps an empty backend result successful after occurrences become unavailable", async () => {
    mockApiInstance.describeSchedule = [
      { relativePath: "empty.jpg", status: "ok", edits: [] },
    ];
    mockApiInstance.beforeDescribeProgress = () =>
      mockApiInstance.invalidateMetadataOccurrences("empty.jpg");
    const { user, aiBtn } = await startAiDescription("empty.jpg");
    await user.click(aiBtn);
    const targetDraftBefore = mockApiInstance.invocations.filter(
      ({ cmd }) => cmd === "save_metadata_draft_edits",
    ).length;

    await user.click(await screen.findByTestId("describe-confirm-btn"));
    const done = await screen.findByTestId("describe-done-summary");

    expect(done).toHaveTextContent(/1 succeeded/i);
    expect(screen.queryByTestId("describe-failure-list")).toBeNull();
    expect(mockApiInstance.targetDraftEditsByFolder["/files"] ?? {}).toEqual(
      {},
    );
    expect(
      mockApiInstance.invocations.filter(
        ({ cmd }) => cmd === "save_metadata_draft_edits",
      ).length - targetDraftBefore,
    ).toBe(0);
  });

  it("stages backend-emitted edits as exact target-aware targets", async () => {
    // Regression: the frontend used to rely on the backend writing
    // the persisted target-draft file directly, so the UI never saw the new edits
    // after a describe run completed. The architecture now ships edits
    // in the per-image progress event and the hook funnels them through
    // semantic draft batch setter — proven here by inspecting the mock's draft store
    // after the run.
    mockApiInstance.settings = {
      openai_api_key: "sk-test",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    mockApiInstance.describeSchedule = [
      {
        relativePath: "test.jpg",
        status: "ok",
        edits: mockGeneratedDraftEntries({
          "XMP-mlib:AIDescription": {
            value: { kind: "Text", value: "a calm beach scene" },
            intent: "Set",
          },
          "XMP-mlib:AITags": {
            value: {
              kind: "List",
              value: {
                list_kind: "Bag",
                items: [{ kind: "Text", value: "beach" }],
              },
            },
            intent: "Set",
          },
        }),
      },
    ];

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(await screen.findByTestId("describe-confirm-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await screen.findByTestId("describe-done-summary");

    const targetDrafts =
      mockApiInstance.targetDraftEditsByFolder["/files"]?.["test.jpg"] ?? {};
    expect(
      Object.values(targetDrafts).some(
        ({ target }) => target.schema_id.tag_id === "AIDescription",
      ),
    ).toBe(true);
    expect(
      Object.values(targetDrafts).some(
        ({ target }) => target.schema_id.tag_id === "AITags",
      ),
    ).toBe(true);
    expect(
      Object.values(targetDrafts).every(
        ({ target }) => target.kind === "NewProperty",
      ),
    ).toBe(true);
  });

  it("compares done actual cost against the confirmation estimate", async () => {
    mockApiInstance.describeEstimateComplete = {
      totalInputTokens: 1000,
      predictedCostUsd: 0.004,
      upperBoundCostUsd: 0.008,
      model: "gpt-4o",
      estimateMode: "heuristic",
    };
    mockApiInstance.describeUsageSummary = {
      totalInputTokens: 1200,
      totalCachedTokens: 0,
      totalCacheWriteTokens: 0,
      totalOutputTokens: 300,
      totalReasoningTokens: 100,
      totalNonReasoningOutputTokens: 200,
      serviceTier: "default",
      reasoningEffort: "medium",
      predictedCostUsd: 0.005,
      actualCostUsd: 0.006,
    };

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(await screen.findByTestId("describe-confirm-btn"));
    await screen.findByTestId("describe-done-summary");

    expect(screen.getByTestId("describe-usage-summary")).toHaveTextContent(
      /50% vs estimate/,
    );
    expect(screen.getByTestId("describe-usage-summary")).toHaveTextContent(
      /reasoning 100; visible 200/i,
    );
    expect(screen.getByTestId("describe-usage-summary")).toHaveTextContent(
      /Service tier: default · Reasoning effort: medium/i,
    );
  });

  it("renders per-image failures in the done panel", async () => {
    mockApiInstance.settings = {
      openai_api_key: "sk-test",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    mockApiInstance.describeSchedule = [
      {
        relativePath: "test.jpg",
        status: "incomplete",
        error: "max_output_tokens",
      },
    ];

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(await screen.findByTestId("describe-confirm-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await screen.findByTestId("describe-done-summary");
    // Failure list is gated behind a <details> element.
    // Friendly label replaces the raw `incomplete` kind in the visible
    // text; the raw kind and detail remain accessible via the `title`
    // tooltip on the row.
    expect(screen.getByTestId("describe-failure-list")).toHaveTextContent(
      /Response was truncated/i,
    );
    expect(screen.getByTestId("describe-failure-list")).toHaveTextContent(
      /max_output_tokens/,
    );
  });

  it("surfaces the overwrite notice inside the dialog when an AI description already exists", async () => {
    // The notice replaced the old pre-dialog ask() warning. It appears
    // in the awaiting-confirm panel only when the selection includes
    // files whose AIDescription is already set in metadata or drafts.
    mockApiInstance.settings = {
      openai_api_key: "sk-test",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    mockApiInstance.describeEstimateComplete = {
      totalInputTokens: 100,
      predictedCostUsd: 0.01,
      upperBoundCostUsd: 0.02,
      model: "gpt-4o",
      estimateMode: "heuristic",
    };
    const { user, file } = await openFolderWithFile("test.jpg");
    await act(async () => {
      mockApiInstance.emitFileMetadataReady(file.relative_path, {
        "XMP-mlib:AIDescription": {
          kind: "Text",
          value: "older description",
        },
      });
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 100));
    });

    const row = screen.getByTestId("file-row");
    await user.dblClick(row);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await user.click(screen.getByTestId("gallery-info-toggle"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await user.click(await screen.findByTestId("details-pane-generate-ai-btn"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    await screen.findByTestId("describe-confirm-btn");
    const notice = await screen.findByTestId("describe-overwrite-notice");
    expect(notice).toHaveTextContent(/Overwrite AI description\?/);
    expect(notice).toHaveTextContent(/already has an AI description/i);
  });

  it("cancel during awaiting-confirm closes the dialog and signals backend", async () => {
    mockApiInstance.settings = {
      openai_api_key: "sk-test",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const cancelBtn = await screen.findByTestId("describe-cancel-btn");
    await user.click(cancelBtn);
    expect(mockApiInstance.cancelDescribeCalled).toBe(true);
    await waitFor(() => {
      expect(
        screen.queryByTestId("describe-progress-dialog"),
      ).not.toBeInTheDocument();
    });
  });

  it("Escape key in pre-run phase closes the dialog and signals backend", async () => {
    mockApiInstance.settings = {
      openai_api_key: "sk-test",
      openai_model: "gpt-4o",
      normalise_metadata_model: "gpt-5.4-nano",
      normalise_location_model: "gpt-5.4-nano",
      ai_cost_estimate_mode: "heuristic",
      describe_concurrency: 6,
      normalise_concurrency: 4,
      metadata_scan_concurrency: 4,
      metadata_scan_batch_size: 20,
      metadata_apply_batch_size: 8,
      metadata_apply_concurrency: 4,
      thumbnail_concurrency: 8,
    };
    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await screen.findByTestId("describe-cancel-btn");
    await user.keyboard("{Escape}");
    expect(mockApiInstance.cancelDescribeCalled).toBe(true);
    await waitFor(() => {
      expect(
        screen.queryByTestId("describe-progress-dialog"),
      ).not.toBeInTheDocument();
    });
  });
});

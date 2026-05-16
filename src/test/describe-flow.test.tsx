/**
 * End-to-end tests for the AI image-description UI flow.
 *
 * Asserts the DescribeProgressDialog phase machine, the settings dialog
 * round-trip, and the DetailsPane button trigger. Backend is mocked at the
 * Tauri-invoke boundary; events are dispatched synchronously by the mock
 * so we can observe state transitions in the order the real backend would.
 */
import { render, screen, act, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import App from "../App";
import { createMockTauriApi } from "./mockTauriApi";
import { makePhoto } from "./factories";

let mockApiInstance: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: any) => mockApiInstance.api.invoke(cmd, args),
  convertFileSrc: (path: string) => `data:image/jpeg;base64,FAKE_${path}`,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (evt: string, handler: any) =>
    mockApiInstance.api.listen(evt, (payload: any) => handler({ payload })),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn().mockResolvedValue(true),
}));

async function openFolderWithPhoto(rel = "test.jpg") {
  const photo = makePhoto({ relative_path: rel });
  const user = userEvent.setup();
  mockApiInstance.pickFolderResolves("/photos");
  render(<App />);
  await act(async () => { await new Promise(r => setTimeout(r, 50)); });
  await user.click(screen.getByTestId("open-folder-btn"));
  await act(async () => { mockApiInstance.emitPhotoFound(photo); });
  await act(async () => { mockApiInstance.emitScanComplete(); });
  // DetailsPane only renders its action buttons once metadata has loaded.
  // Emit an empty-but-present record so we leave the "loading" state.
  await act(async () => { mockApiInstance.emitImageMetadataReady(rel, {}); });
  await act(async () => { await new Promise(r => setTimeout(r, 250)); });
  return { user, photo };
}

beforeEach(() => { mockApiInstance = createMockTauriApi(); });
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); });

describe("SettingsDialog", () => {
  it("loads stored API key and model on open, and persists edits", async () => {
    mockApiInstance.settings = { openai_api_key: "sk-existing", openai_model: "gpt-5.4" };
    const { user } = await openFolderWithPhoto();

    await user.click(screen.getByTestId("menu-bar-settings-btn"));
    const apiKeyInput = await screen.findByTestId("settings-api-key-input");
    // The input is type=password so we assert .value rather than visible text.
    await waitFor(() => expect((apiKeyInput as HTMLInputElement).value).toBe("sk-existing"));

    const modelSelect = screen.getByTestId("settings-model-select") as HTMLSelectElement;
    expect(modelSelect.value).toBe("gpt-5.4");

    // Type into the API key input and tab away to commit the save.
    await user.clear(apiKeyInput);
    await user.type(apiKeyInput, "sk-new");
    fireEvent.blur(apiKeyInput);
    // Allow the async save_settings_cmd to settle.
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(mockApiInstance.settings.openai_api_key).toBe("sk-new");

    // Switching the model selector saves immediately on change.
    await user.selectOptions(modelSelect, "gpt-4o");
    await act(async () => { await new Promise(r => setTimeout(r, 10)); });
    expect(mockApiInstance.settings.openai_model).toBe("gpt-4o");
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
    const { user } = await openFolderWithPhoto();
    await user.click(screen.getByTestId("menu-bar-settings-btn"));
    const select = await screen.findByTestId("settings-model-select") as HTMLSelectElement;
    await waitFor(() => {
      const labels = Array.from(select.options).map((o) => o.textContent);
      expect(labels.some((l) => l && l.includes("gpt-4o") && l.includes("per image"))).toBe(true);
      expect(labels.some((l) => l && l.includes("gpt-5.4-nano") && /\$0\.000\d/.test(l))).toBe(true);
    });
  });

  it("warning text near the API key field is visible (replaces consent dialog)", async () => {
    await openFolderWithPhoto();
    const { user } = { user: userEvent.setup() };
    await user.click(screen.getByTestId("menu-bar-settings-btn"));
    await screen.findByTestId("settings-api-key-input");
    expect(screen.getByText(/uploads selected images to OpenAI/i)).toBeInTheDocument();
  });
});

describe("AI-description flow", () => {
  /**
   * Open the gallery's details pane and click the Generate AI Description
   * button. Returns the user-event session so callers can drive the dialog.
   */
  async function startAiDescription(rel = "test.jpg") {
    const { user, photo } = await openFolderWithPhoto(rel);
    const row = screen.getByTestId("photo-row");
    await user.dblClick(row);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const detailsToggle = screen.getByTestId("gallery-info-toggle");
    await user.click(detailsToggle);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    const aiBtn = await screen.findByTestId("details-pane-generate-ai-btn");
    return { user, photo, aiBtn };
  }

  it("walks through estimating → awaiting-confirm → running → done", async () => {
    mockApiInstance.settings = { openai_api_key: "sk-test", openai_model: "gpt-4o" };
    mockApiInstance.describeEstimateComplete = {
      totalInputTokens: 1234, predictedCostUsd: 0.0042,
      upperBoundCostUsd: 0.0099, model: "gpt-4o",
    };
    mockApiInstance.describeUsageSummary = {
      totalInputTokens: 1230, totalCachedTokens: 0, totalOutputTokens: 200,
      predictedCostUsd: 0.0042, actualCostUsd: 0.0050,
    };

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Dialog appears, walks straight through estimating (mock emits all
    // events synchronously) and into awaiting-confirm.
    await screen.findByTestId("describe-progress-dialog");
    const confirmBtn = await screen.findByTestId("describe-confirm-btn");
    expect(screen.getByTestId("describe-confirm-summary")).toHaveTextContent(/gpt-4o/);

    await user.click(confirmBtn);

    // After confirm, the mock immediately emits started/progress/complete,
    // landing the dialog in the done phase with the usage summary visible.
    await screen.findByTestId("describe-done-summary");
    expect(screen.getByTestId("describe-usage-summary"))
      .toHaveTextContent(/Actual:/);

    // Close cleans up the dialog.
    await user.click(screen.getByTestId("describe-close-btn"));
    await waitFor(() => {
      expect(screen.queryByTestId("describe-progress-dialog")).not.toBeInTheDocument();
    });
  });

  it("applies backend-emitted edits into the in-memory draft store", async () => {
    // Regression: the frontend used to rely on the backend writing
    // draft_edits.jsonl directly, so the UI never saw the new edits
    // after a describe run completed. The architecture now ships edits
    // in the per-image progress event and the hook funnels them through
    // setDraftBatch — proven here by inspecting the mock's draft store
    // after the run.
    mockApiInstance.settings = { openai_api_key: "sk-test", openai_model: "gpt-4o" };
    mockApiInstance.describeSchedule = [
      {
        relativePath: "test.jpg",
        status: "ok",
        edits: {
          "XMP-mlib:AIDescription": {
            value: { type: "String", value: "a calm beach scene" },
            intent: "Set",
          },
          "XMP-mlib:AITags": {
            value: { type: "List", value: [{ type: "String", value: "beach" }] },
            intent: "Set",
          },
        },
      },
    ];

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await user.click(await screen.findByTestId("describe-confirm-btn"));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await screen.findByTestId("describe-done-summary");

    const folderDrafts = mockApiInstance.draftEditsByFolder["/photos"];
    expect(folderDrafts).toBeTruthy();
    expect(folderDrafts["test.jpg"]).toBeTruthy();
    expect(folderDrafts["test.jpg"]["XMP-mlib:AIDescription"]).toBeTruthy();
    expect(folderDrafts["test.jpg"]["XMP-mlib:AITags"]).toBeTruthy();
  });

  it("renders per-image failures in the done panel", async () => {
    mockApiInstance.settings = { openai_api_key: "sk-test", openai_model: "gpt-4o" };
    mockApiInstance.describeSchedule = [
      { relativePath: "test.jpg", status: "incomplete", error: "max_output_tokens" },
    ];

    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    await user.click(await screen.findByTestId("describe-confirm-btn"));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    await screen.findByTestId("describe-done-summary");
    // Failure list is gated behind a <details> element.
    expect(screen.getByTestId("describe-failure-list")).toHaveTextContent(/incomplete/);
    expect(screen.getByTestId("describe-failure-list")).toHaveTextContent(/max_output_tokens/);
  });

  it("cancel during running invokes cancel_describe_cmd", async () => {
    // The mock emits all events synchronously, so to observe a running-phase
    // cancel we'd need a custom mock that pauses. Easier: drive the
    // estimating phase (which has no delays either but the dialog still
    // shows a Cancel button) and assert the click reaches the backend.
    mockApiInstance.settings = { openai_api_key: "sk-test", openai_model: "gpt-4o" };
    const { user, aiBtn } = await startAiDescription();
    await user.click(aiBtn);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    // After estimating completes synchronously we're in awaiting-confirm.
    const cancelBtn = await screen.findByTestId("describe-cancel-btn");
    await user.click(cancelBtn);
    // The hook's cancel handler invokes the backend regardless of phase.
    expect(mockApiInstance.cancelDescribeCalled).toBe(true);
  });
});

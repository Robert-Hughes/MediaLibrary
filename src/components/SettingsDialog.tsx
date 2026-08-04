import { ModalDialog } from "./ModalDialog";
/**
 * Settings dialog — V1 surface is API key + model.
 *
 * Auto-saves on field commit (blur for the text input, change for the
 * select) so the user never has to hit a "Save" button. Includes the
 * privacy warning text next to the API-key input, replacing the
 * dedicated first-run consent dialog.
 *
 * Owns its own load/save lifecycle so the rest of the app doesn't need to
 * thread settings state through useMediaLibrary.
 */
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings } from "../types/generated/Settings";

interface Props {
  onClose: () => void;
}

/**
 * Format a USD cost compactly for the model dropdown. Sub-cent figures
 * keep four decimal places so users can compare cheap models meaningfully
 * (gpt-5.4-nano at $0.0003 vs gpt-5.4-mini at $0.0014).
 */
function formatPerImageCost(usd: number): string {
  if (usd < 0.01) return `~$${usd.toFixed(4)}`;
  return `~$${usd.toFixed(3)}`;
}

const CONCURRENCY_OPTIONS = Array.from({ length: 16 }, (_, index) => index + 1);
const BATCH_SIZE_OPTIONS = [1, 5, 10, 20, 30, 50, 100];
const APPLY_BATCH_SIZE_OPTIONS = [1, 2, 4, 8, 16, 32, 50, 100];

export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  /** Model id → ballpark per-image cost in USD. Missing entries are
   *  rendered without a cost suffix so an unknown model is still pickable. */
  const [perImageCosts, setPerImageCosts] = useState<Record<string, number>>(
    {},
  );
  /** Model id → per-file cost for the metadata-normaliser worst case
   *  (both Group B and Group C fire). Plan §6. */
  const [normaliseCosts, setNormaliseCosts] = useState<Record<string, number>>(
    {},
  );
  const [locationNormaliseCosts, setLocationNormaliseCosts] = useState<
    Record<string, number>
  >({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, ms] = await Promise.all([
          invoke<Settings>("load_settings_cmd"),
          invoke<string[]>("list_recommended_models"),
        ]);
        if (cancelled) return;
        setSettings(s);
        setModels(ms);
        // Fire the per-model cost queries in parallel — the backend
        // already has the pricing table so each call is local-only. We
        // tolerate per-model failures (Promise.allSettled) so one bad
        // entry doesn't blank the dropdown's cost column.
        const results = await Promise.allSettled(
          ms.map((m) =>
            invoke<number>("estimate_per_image_cost_cmd", { model: m }).then(
              (cost) => [m, cost] as const,
            ),
          ),
        );
        if (cancelled) return;
        const costs: Record<string, number> = {};
        for (const r of results) {
          if (r.status === "fulfilled") {
            const [m, c] = r.value;
            costs[m] = c;
          }
        }
        setPerImageCosts(costs);

        // Same allSettled pattern for the normaliser cost preview.
        const nResults = await Promise.allSettled(
          ms.map((m) =>
            invoke<number>("estimate_per_file_normalise_cost_cmd", {
              model: m,
            }).then((cost) => [m, cost] as const),
          ),
        );
        if (cancelled) return;
        const nCosts: Record<string, number> = {};
        for (const r of nResults) {
          if (r.status === "fulfilled") {
            const [m, c] = r.value;
            nCosts[m] = c;
          }
        }
        setNormaliseCosts(nCosts);

        const lResults = await Promise.allSettled(
          ms.map((m) =>
            invoke<number>("estimate_per_file_location_normalise_cost_cmd", {
              model: m,
            }).then((cost) => [m, cost] as const),
          ),
        );
        if (cancelled) return;
        const lCosts: Record<string, number> = {};
        for (const r of lResults) {
          if (r.status === "fulfilled") {
            const [m, c] = r.value;
            lCosts[m] = c;
          }
        }
        setLocationNormaliseCosts(lCosts);
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(updated: Settings) {
    setSettings(updated);
    setSaveError(null);
    try {
      await invoke("save_settings_cmd", { settingsData: updated });
    } catch (e) {
      setSaveError(String(e));
    }
  }

  return (
    <ModalDialog
      open
      onDismiss={onClose}
      testId="settings-dialog"
      aria-label="Settings"
    >
      <div className="dialog-content" style={{ width: 520 }}>
        <div className="dialog-header">
          <span className="dialog-title">Settings</span>
        </div>
        <div className="dialog-body">
          {loadError && (
            <div style={{ color: "var(--accent-error, #d33)" }}>
              Failed to load settings: {loadError}
            </div>
          )}
          {settings && (
            <>
              <section style={{ marginBottom: 16 }}>
                <h3 style={{ marginBottom: 6 }}>AI image description</h3>
                <label
                  style={{ display: "block", fontSize: 12, marginBottom: 4 }}
                >
                  OpenAI API key
                </label>
                <input
                  type="password"
                  data-testid="settings-api-key-input"
                  value={settings.openai_api_key}
                  onChange={(e) =>
                    setSettings({ ...settings, openai_api_key: e.target.value })
                  }
                  onBlur={() => persist(settings)}
                  placeholder="sk-…"
                  style={{ width: "100%", padding: 6, fontFamily: "monospace" }}
                />
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Stored in plain text in your app data folder. The key is used
                  for AI image description and for metadata normalisation when
                  AI merge/title branches are enabled. AI image description
                  uploads selected images to OpenAI for analysis; metadata
                  normalisation sends text prompts only. Don't enter a key here
                  if your images or metadata contain content you cannot send to
                  a third-party service.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Model
                </label>
                <select
                  data-testid="settings-model-select"
                  value={settings.openai_model}
                  onChange={(e) =>
                    persist({ ...settings, openai_model: e.target.value })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {models.map((m) => {
                    const c = perImageCosts[m];
                    const label =
                      c !== undefined
                        ? `${m} (${formatPerImageCost(c)} per image)`
                        : m;
                    return (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    );
                  })}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  gpt-5.6-luna is the recommended default: native reasoning
                  names landmarks reliably at low cost (≈$0.0018 per 1024px
                  image). See docs/IMAGE_ANALYSIS.md for the model-choice
                  rationale.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  AI cost estimate
                </label>
                <select
                  data-testid="settings-ai-cost-estimate-mode-select"
                  value={settings.ai_cost_estimate_mode}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      ai_cost_estimate_mode: e.target.value as
                        "heuristic" | "exact",
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  <option value="heuristic">Fast local estimate</option>
                  <option value="exact">Exact OpenAI token preflight</option>
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Fast local estimate avoids OpenAI calls before confirmation.
                  Exact preflight calls OpenAI before confirmation to count
                  tokens. For AI image description, exact preflight uploads
                  selected image bytes once before the real run. For metadata
                  normalisation, exact preflight sends only text prompts, not
                  image bytes. Metadata normalisation may still take a moment in
                  fast mode because it locally checks which fields and AI
                  branches would change.
                </div>
              </section>

              <section style={{ marginBottom: 16 }}>
                <h3 style={{ marginBottom: 6 }}>Location normalisation</h3>
                <label
                  style={{ display: "block", fontSize: 12, marginBottom: 4 }}
                >
                  Model (text-only)
                </label>
                <select
                  data-testid="settings-normalise-location-model-select"
                  value={settings.normalise_location_model}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      normalise_location_model: e.target.value,
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {models.map((m) => {
                    const c = locationNormaliseCosts[m];
                    const label =
                      c !== undefined
                        ? `${m} (${formatPerImageCost(c)} per location)`
                        : m;
                    return (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    );
                  })}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Used only when GeocodeJSON or JSONv2 evidence exists and
                  LocationCreated is absent. This setting is separate so
                  location-name quality can be compared independently.
                  gpt-5.6-luna is the recommended default for consistent address
                  hierarchy resolution.
                </div>
              </section>

              <section style={{ marginBottom: 16 }}>
                <h3 style={{ marginBottom: 6 }}>Metadata normalisation</h3>
                <label
                  style={{ display: "block", fontSize: 12, marginBottom: 4 }}
                >
                  Model (text-only)
                </label>
                <select
                  data-testid="settings-normalise-model-select"
                  value={settings.normalise_metadata_model}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      normalise_metadata_model: e.target.value,
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {models.map((m) => {
                    const c = normaliseCosts[m];
                    const label =
                      c !== undefined
                        ? `${m} (${formatPerImageCost(c)} per file when AI fires)`
                        : m;
                    return (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    );
                  })}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Used by Normalise Metadata when description sources disagree
                  or a title has to be generated from the description. Text-only
                  — image bytes are never sent. See
                  docs/NORMALISE_METADATA_PLAN.md §6.
                </div>
              </section>

              <section style={{ marginBottom: 16 }}>
                <h3 style={{ marginBottom: 6 }}>Performance</h3>
                <label
                  style={{ display: "block", fontSize: 12, marginBottom: 4 }}
                >
                  AI Describe concurrency
                </label>
                <select
                  data-testid="settings-describe-concurrency-select"
                  value={settings.describe_concurrency}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      describe_concurrency: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {CONCURRENCY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value === 12 ? `${value} (recommended)` : value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Maximum OpenAI image-description requests in flight. Applies
                  to the next Describe run.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Metadata normalise concurrency
                </label>
                <select
                  data-testid="settings-normalise-concurrency-select"
                  value={settings.normalise_concurrency}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      normalise_concurrency: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {CONCURRENCY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value === 12 ? `${value} (recommended)` : value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Maximum OpenAI metadata-normalisation requests in flight.
                  Applies to the next Normalize Metadata run.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Metadata scanner concurrency
                </label>
                <select
                  data-testid="settings-metadata-scan-concurrency-select"
                  value={settings.metadata_scan_concurrency}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      metadata_scan_concurrency: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {CONCURRENCY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Metadata workers run ExifTool processes. Applies to the next
                  folder scan.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Metadata scanner batch size
                </label>
                <select
                  data-testid="settings-metadata-scan-batch-size-select"
                  value={settings.metadata_scan_batch_size}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      metadata_scan_batch_size: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {BATCH_SIZE_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Maximum files passed to each metadata ExifTool read. Applies
                  to the next folder scan.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Metadata apply batch size
                </label>
                <select
                  data-testid="settings-metadata-apply-batch-size-select"
                  value={settings.metadata_apply_batch_size}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      metadata_apply_batch_size: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {APPLY_BATCH_SIZE_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value === 32 ? `${value} (recommended)` : value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Files grouped into each batched metadata read during Apply.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Metadata apply write concurrency
                </label>
                <select
                  data-testid="settings-metadata-apply-concurrency-select"
                  value={settings.metadata_apply_concurrency}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      metadata_apply_concurrency: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {CONCURRENCY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value === 8 ? `${value} (recommended)` : value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Maximum metadata file writes in flight during Apply.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 12,
                    marginTop: 12,
                    marginBottom: 4,
                  }}
                >
                  Thumbnail generation concurrency
                </label>
                <select
                  data-testid="settings-thumbnail-concurrency-select"
                  value={settings.thumbnail_concurrency}
                  onChange={(e) =>
                    persist({
                      ...settings,
                      thumbnail_concurrency: Number(e.target.value),
                    })
                  }
                  style={{ width: "100%", padding: 6 }}
                >
                  {CONCURRENCY_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  Number of images decoded and resized for thumbnails at once.
                  Applies to the next folder scan.
                </div>
              </section>

              {saveError && (
                <div
                  data-testid="settings-save-error"
                  style={{ color: "var(--accent-error, #d33)" }}
                >
                  Save failed: {saveError}
                </div>
              )}
            </>
          )}

          <div
            style={{
              marginTop: 20,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <button
              className="button button--primary"
              data-testid="settings-close-btn"
              onClick={onClose}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
}

export default SettingsDialog;

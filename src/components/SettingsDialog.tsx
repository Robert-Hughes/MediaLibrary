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
import { useDialogEscape } from "../hooks/useDialogEscape";

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

export function SettingsDialog({ onClose }: Props) {
  useDialogEscape(onClose);

  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
  /** Model id → ballpark per-image cost in USD. Missing entries are
   *  rendered without a cost suffix so an unknown model is still pickable. */
  const [perImageCosts, setPerImageCosts] = useState<Record<string, number>>(
    {},
  );
  /** Model id → per-photo cost for the metadata-normaliser worst case
   *  (both Group B and Group C fire). Plan §6. */
  const [normaliseCosts, setNormaliseCosts] = useState<Record<string, number>>(
    {},
  );
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
            invoke<number>("estimate_per_image_normalise_cost_cmd", {
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
    <div className="dialog-overlay" data-testid="settings-dialog">
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
                  gpt-4o is the recommended default: names landmarks reliably at
                  moderate cost (≈$0.002 per 1024px image). See
                  docs/IMAGE_ANALYSIS.md for the model-choice rationale.
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
                        ? `${m} (${formatPerImageCost(c)} per photo when AI fires)`
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
    </div>
  );
}

export default SettingsDialog;

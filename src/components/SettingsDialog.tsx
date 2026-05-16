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

export function SettingsDialog({ onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<string[]>([]);
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
      } catch (e) {
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => { cancelled = true; };
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
                <label style={{ display: "block", fontSize: 12, marginBottom: 4 }}>
                  OpenAI API key
                </label>
                <input
                  type="password"
                  data-testid="settings-api-key-input"
                  value={settings.openai_api_key}
                  onChange={(e) => setSettings({ ...settings, openai_api_key: e.target.value })}
                  onBlur={() => persist(settings)}
                  placeholder="sk-…"
                  style={{ width: "100%", padding: 6, fontFamily: "monospace" }}
                />
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-secondary)" }}>
                  Stored in plain text in your app data folder. The key is
                  used only for the AI-description feature. Enabling this
                  feature uploads selected images to OpenAI for analysis —
                  don't enter a key here if your images contain content you
                  cannot send to a third-party service.
                </div>

                <label style={{ display: "block", fontSize: 12, marginTop: 12, marginBottom: 4 }}>
                  Model
                </label>
                <select
                  data-testid="settings-model-select"
                  value={settings.openai_model}
                  onChange={(e) => persist({ ...settings, openai_model: e.target.value })}
                  style={{ width: "100%", padding: 6 }}
                >
                  {models.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-secondary)" }}>
                  gpt-4o is the recommended default: names landmarks
                  reliably at moderate cost (≈$0.002 per 1024px image).
                  See docs/IMAGE_ANALYSIS.md for the model-choice rationale.
                </div>
              </section>

              {saveError && (
                <div data-testid="settings-save-error" style={{ color: "var(--accent-error, #d33)" }}>
                  Save failed: {saveError}
                </div>
              )}
            </>
          )}

          <div style={{ marginTop: 20, display: "flex", justifyContent: "flex-end" }}>
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

/**
 * Coverage for the DetailsPane "Reverse Geocode…" button (single-image
 * overwrite-warning flow).
 *
 * Pinned by docs/REVERSE_GEOCODE_PLAN.md §5 (DetailsPane single-image
 * variant). Verifies:
 *
 *   - the button is always rendered when the parent wires `onGeocode`
 *     (no GPS-presence filter — `no_gps` surfaces as a per-image failure
 *     in the done panel instead);
 *   - clicking with no §1 location data invokes `onGeocode` directly
 *     without a confirmation dialog;
 *   - any §1 target tag present in **metadata** triggers the overwrite
 *     `ask()` with the plan-mandated copy and title;
 *   - any §1 target tag present in the **typed draft store** triggers
 *     the same warning;
 *   - any §1 target tag present in the **legacy draft map** triggers it
 *     too (it's the fallback when `typedDraftEdits` is absent);
 *   - dismissing the warning suppresses the callback.
 *
 * `ask` is mocked at module scope so tests can decide per-case whether
 * the user confirms or cancels.
 */
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { makePhoto } from "./factories";
import type { DraftEdit } from "../types";
import { GEOCODE_TARGET_TAGS } from "../types";

// ── Mocks ───────────────────────────────────────────────────────────────────
//
// Plugin-dialog's `ask` is the user-visible confirmation prompt. We mock
// it so we can both inspect the call args and decide per-test whether
// the simulated user confirms. The `@tauri-apps/api/core` invoke is
// unused by DetailsPane in these flows but the import path is touched
// indirectly, so stub it to avoid leaking to a real Tauri runtime.

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const setDraftEdit = (value: string): DraftEdit => ({
  value: { type: "String", value },
  intent: "Set",
});

const photo = makePhoto({
  relative_path: "p.jpg",
  filename: "p.jpg",
  date_modified: 0,
  date_created: 0,
});

async function getAskMock() {
  const mod = await import("@tauri-apps/plugin-dialog");
  return (mod as unknown as { ask: ReturnType<typeof vi.fn> }).ask;
}

describe("DetailsPane: Reverse Geocode button (plan §5 single-image)", () => {
  beforeEach(async () => {
    cleanup();
    const ask = await getAskMock();
    ask.mockClear();
    ask.mockResolvedValue(true);
  });

  it("renders the button whenever onGeocode is wired (no GPS gate)", () => {
    // Plan §5 'Context menu visibility' covers the multi-select entry
    // but the same rule applies here: the button is always visible so
    // a no_gps photo surfaces as a per-image failure in the done panel
    // rather than being silently filtered out at the entry point.
    const onGeocode = vi.fn();
    render(
      <DetailsPane photo={photo} metadata={{}} onGeocode={onGeocode} />,
    );
    expect(screen.getByTestId("details-pane-geocode-btn")).toBeInTheDocument();
  });

  it("does not render the button when onGeocode is not provided", () => {
    // Read-only / older render paths (e.g. tests that don't wire the
    // feature) shouldn't accidentally surface a non-functional button.
    render(<DetailsPane photo={photo} metadata={{}} />);
    expect(screen.queryByTestId("details-pane-geocode-btn")).toBeNull();
  });

  it("calls onGeocode immediately when no §1 location data is present", async () => {
    // No location keys in metadata or drafts → no overwrite warning →
    // the callback fires synchronously after the user click.
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "Composite:GPSLatitude": 51.5, "Composite:GPSLongitude": -0.1 }}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledTimes(1);
  });

  // The plan lists ten target tags. Spot-check each one individually so a
  // future change to GEOCODE_TARGET_TAGS that drops a key (and therefore
  // weakens the warning) fails loudly here, not silently in production.
  for (const tag of GEOCODE_TARGET_TAGS) {
    it(`asks for confirmation when "${tag}" is present in metadata`, async () => {
      const onGeocode = vi.fn();
      const user = userEvent.setup();
      render(
        <DetailsPane
          photo={photo}
          metadata={{ [tag]: "Existing Value" }}
          onGeocode={onGeocode}
        />,
      );
      await user.click(screen.getByTestId("details-pane-geocode-btn"));
      const ask = await getAskMock();
      expect(ask).toHaveBeenCalledTimes(1);
      expect(ask).toHaveBeenCalledWith(
        expect.stringMatching(/already has location data/i),
        expect.objectContaining({ title: "Overwrite location data?", kind: "warning" }),
      );
      // ask resolves true in this beforeEach setup, so the callback fires.
      expect(onGeocode).toHaveBeenCalledTimes(1);
    });
  }

  it("asks for confirmation when a §1 tag is present in the typed draft store", async () => {
    // Drafts are checked alongside metadata so a half-edited photo
    // (location written as draft but not yet applied) still triggers the
    // warning — otherwise reverse-geocoding could silently clobber an
    // in-progress manual edit.
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        typedDraftEdits={{ "XMP-photoshop:City": setDraftEdit("Manual Edit") }}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    const ask = await getAskMock();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onGeocode).toHaveBeenCalledTimes(1);
  });

  it("asks for confirmation when a §1 tag is present only in the legacy draft map", async () => {
    // Older render paths don't pass `typedDraftEdits`; the legacy
    // `draftEdits` string map is the fallback signal. Cover it so the
    // warning never silently disappears for these callers.
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={{}}
        draftEdits={{ "IPTC:City": "Legacy Draft" }}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    const ask = await getAskMock();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onGeocode).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onGeocode when the user dismisses the warning", async () => {
    // The whole point of the confirmation is letting the user bail. If
    // `ask` returns false the geocode flow must not start.
    const ask = await getAskMock();
    ask.mockResolvedValueOnce(false);
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "XMP-iptcCore:Location": "Existing Place" }}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(onGeocode).not.toHaveBeenCalled();
  });

  it("warning copy mentions that absent fields are cleared (coherent-replacement rule)", async () => {
    // Plan §1: the user's only signal that an empty Nominatim response
    // will delete an existing City/State/Country value is this copy.
    // Pin it here so a future copy edit doesn't quietly drop the
    // "fields the geocoder doesn't return will be cleared" clause.
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={{ "IPTC:Country-PrimaryLocationName": "France" }}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    const ask = await getAskMock();
    const message = ask.mock.calls[0]?.[0] as string;
    expect(message).toMatch(/will be cleared/i);
  });
});

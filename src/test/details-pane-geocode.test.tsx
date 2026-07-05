/**
 * Coverage for the DetailsPane "Reverse Geocode…" button (single-image
 * variant).
 *
 * The overwrite warning that used to live here (pre-dialog `ask()`) has
 * been folded into GeocodeProgressDialog's awaiting-confirm panel — see
 * `geocode-progress-dialog.test.tsx` for that coverage. This file now
 * pins only the button's local responsibilities:
 *
 *   - the button is always rendered when the parent wires `onGeocode`
 *     (no GPS-presence filter — `no_gps` surfaces as a per-image failure
 *     in the done panel instead);
 *   - clicking the button invokes `onGeocode` directly, regardless of
 *     whether any §1 location data is present in metadata or drafts;
 *   - no `ask()` round-trip is fired any more.
 */
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";
import { makePhoto, mockMetadata } from "./factories";
import type { MetadataDraftEdit } from "../types";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

const setDraftEdit = (value: string): MetadataDraftEdit => ({
  value: { kind: "Text", value },
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

describe("DetailsPane: Reverse Geocode button", () => {
  beforeEach(async () => {
    cleanup();
    const ask = await getAskMock();
    ask.mockClear();
  });

  it("renders the button whenever onGeocode is wired (no GPS gate)", () => {
    const onGeocode = vi.fn();
    render(<DetailsPane photo={photo} metadata={{}} onGeocode={onGeocode} />);
    expect(screen.getByTestId("details-pane-geocode-btn")).toBeInTheDocument();
  });

  it("does not render the button when onGeocode is not provided", () => {
    render(<DetailsPane photo={photo} metadata={{}} />);
    expect(screen.queryByTestId("details-pane-geocode-btn")).toBeNull();
  });

  it("calls onGeocode without prompting when no location data exists", async () => {
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({
          "Composite:GPSLatitude": 51.5,
          "Composite:GPSLongitude": -0.1,
        })}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledTimes(1);
  });

  it("calls onGeocode directly even when a location target tag is present in metadata", async () => {
    // The overwrite notice is rendered inside the dialog now — the
    // button itself does not gate the callback any more.
    const onGeocode = vi.fn();
    const user = userEvent.setup();
    render(
      <DetailsPane
        photo={photo}
        metadata={mockMetadata({ "XMP-iptcCore:Location": "Existing Place" })}
        onGeocode={onGeocode}
      />,
    );
    await user.click(screen.getByTestId("details-pane-geocode-btn"));
    const ask = await getAskMock();
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledTimes(1);
  });

  it("calls onGeocode directly even when a location target tag is present in drafts", async () => {
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
    expect(ask).not.toHaveBeenCalled();
    expect(onGeocode).toHaveBeenCalledTimes(1);
  });
});

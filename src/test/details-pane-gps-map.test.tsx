import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DetailsPane } from "../components/DetailsPane";

import { GpsMapOverview } from "../components/GpsMapOverview";
import { makePhoto, mockMetadata, testFriendlyName } from "./factories";
import type {
  MetadataDraftEdit,
  MetadataTargetDraftEntry,
  MetadataOccurrence,
} from "../types";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { existingOccurrenceTargetFromOccurrence } from "../utils/metadataDraftTarget";
import { buildGeocodeRequestItemForFile } from "../utils/effectiveGps";
import { GPS_IDS } from "../metadata/knownIds";
import {
  _clearTagInfoCache,
  _setTagInfoCacheEntry,
} from "./tagInfoTestHelpers";

import { occurrencesFromMetadataCollection } from "./occurrenceFixtures";
const askMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: askMock,
}));

vi.mock("../components/GpsMap", () => ({
  GpsMap: ({
    position,
    zoom,
    mode,
    showAttribution,
    readOnly,
  }: {
    position: { lat: number; lon: number } | null;
    zoom?: number;
    mode?: "static" | "picker";
    showAttribution?: boolean;
    readOnly?: boolean;
  }) => (
    <div
      data-testid="gps-map"
      data-lat={position ? String(position.lat) : ""}
      data-lon={position ? String(position.lon) : ""}
      data-zoom={zoom}
      data-mode={mode}
      data-show-attribution={String(showAttribution)}
      data-readonly={String(readOnly)}
    />
  ),
}));

describe("DetailsPane GPS Map integration", () => {
  const photo = makePhoto({
    relative_path: "gps-photo.jpg",
    filename: "gps-photo.jpg",
  });

  beforeEach(() => {
    cleanup();
    askMock.mockClear();
    _clearTagInfoCache();
    const commonTags = [
      "GPS:GPSLatitude",
      "GPS:GPSLongitude",
      "GPS:GPSLatitudeRef",
      "GPS:GPSLongitudeRef",
      "IFD0:Make",
    ];
    for (const tag of commonTags) {
      const colon = tag.indexOf(":");
      _setTagInfoCacheEntry(tag, {
        group: tag.slice(0, colon),
        name: tag.slice(colon + 1),
        writable: true,
        kind: { kind: "Text" },
        description: null,
      });
    }
  });

  function occurrencesFor(
    metadata: ReturnType<typeof mockMetadata>,
  ): MetadataOccurrence[] {
    return Object.values(metadata).map((entry) => {
      const { id, ...value } = entry;
      const friendly = testFriendlyName(id);
      const separator = friendly.indexOf(":");
      const group = friendly.slice(0, separator);
      const name = friendly.slice(separator + 1);
      return {
        id: {
          document: null,
          path: `JPEG-APP1-GPS-${id.tag_id}`,
          runtime_tag_id: id.tag_id,
          tag_id_scope: {
            table: "TestFixture::Runtime",
            tag_id: id.tag_id,
            index: null,
          },
          copy: 0,
        },
        schema_id: id,
        value,
        tag_info: {
          id,
          group,
          name,
          writable: true,
          kind: { kind: value.kind } as any,
          description: null,
        },
        observed_selector: {
          group1: group,
          group7: "ID-Test",
          tag_name: name,
        },
        write_target: { group1: group, group7: "ID-Test", tag_name: name },
      };
    });
  }

  function validGpsMetadata() {
    return mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": 0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });
  }

  function gpsHeading() {
    return within(screen.getByTestId("details-section-GPS")).getByRole(
      "heading",
      { name: "GPS", level: 3 },
    );
  }

  it("opens the composite GPS editor from the shared GPS heading menu", async () => {
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(validGpsMetadata())}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    fireEvent.contextMenu(gpsHeading());
    const menu = screen.getByTestId("context-menu");
    expect(
      within(menu).getByRole("button", { name: "Edit GPS…" }),
    ).toBeEnabled();
    expect(within(menu).queryByRole("button", { name: "Edit…" })).toBeNull();
    expect(
      within(menu).queryByRole("button", { name: "Edit destination…" }),
    ).toBeNull();

    fireEvent.click(within(menu).getByRole("button", { name: "Edit GPS…" }));
    expect(await screen.findByText("Edit GPS location")).toBeInTheDocument();
  });

  it("opens identical ordered GPS group options from the overview grid and heading", () => {
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(validGpsMetadata())}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    const optionLabels = () =>
      within(screen.getByTestId("context-menu"))
        .getAllByRole("button")
        .map((button) => button.textContent);

    fireEvent.contextMenu(screen.getByTestId("gps-map-overview-grid"));
    const overviewLabels = optionLabels();
    expect(overviewLabels[0]).toBe("Edit GPS…");
    expect(overviewLabels.some((label) => label?.startsWith("Discard"))).toBe(
      false,
    );

    fireEvent.mouseDown(document.body);
    fireEvent.contextMenu(gpsHeading());
    expect(optionLabels()).toEqual(overviewLabels);
  });

  it("keeps GPS menu actions and counts based on the full group while rows are filtered", async () => {
    _setTagInfoCacheEntry("GPS:GPSVersionID", {
      group: "GPS",
      name: "GPSVersionID",
      writable: true,
      kind: { kind: "Text" },
      description: null,
    });
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitude": 0.1262,
      "GPS:GPSLongitudeRef": "W",
      "GPS:GPSVersionID": "2.2.0.0",
      "IFD0:Make": "Canon",
    });
    const occurrences = occurrencesFor(metadata);
    const occurrenceNamed = (name: string) =>
      occurrences.find((occurrence) => occurrence.tag_info?.name === name)!;
    const targetFor = (name: string) => {
      const result = existingOccurrenceTargetFromOccurrence(
        occurrenceNamed(name),
      );
      if (result.kind !== "targetable") {
        throw new Error(`test occurrence ${name} must be targetable`);
      }
      return result.target;
    };
    const latitudeTarget = targetFor("GPSLatitude");
    const longitudeTarget = targetFor("GPSLongitude");
    const makeTarget = targetFor("Make");
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch(photo.relative_path, [
      {
        target: latitudeTarget,
        edit: { intent: "Set", value: { kind: "Real", value: 52 } },
      },
      {
        target: longitudeTarget,
        edit: { intent: "Set", value: { kind: "Real", value: 1 } },
      },
      {
        target: makeTarget,
        edit: { intent: "Set", value: { kind: "Text", value: "Nikon" } },
      },
    ]);
    const writableGpsCount = occurrences.filter(
      (occurrence) =>
        occurrence.tag_info?.group === "GPS" &&
        occurrence.tag_info.writable === true,
    ).length;
    const expectedRemoveLabel = `Remove all ${writableGpsCount} writable GPS fields…`;

    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrences}
        targetDraftEdits={store.getMetadataFile(photo.relative_path)}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn(() => true)}
      />,
    );

    fireEvent.change(screen.getByTestId("details-search-input"), {
      target: { value: "GPSVersionID" },
    });

    const gpsSection = screen.getByTestId("details-section-GPS");
    expect(gpsSection).toBeInTheDocument();
    expect(within(gpsSection).getByText("GPSVersionID")).toBeInTheDocument();
    expect(within(gpsSection).queryByText("GPSLatitude")).toBeNull();
    expect(within(gpsSection).queryByText("GPSLongitude")).toBeNull();
    expect(within(gpsSection).getAllByTestId("details-row")).toHaveLength(1);
    expect(writableGpsCount).toBeGreaterThan(1);
    expect(screen.getByTestId("gps-map-overview")).toBeInTheDocument();
    expect(screen.getAllByTestId("gps-map")).toHaveLength(4);

    const optionLabels = () =>
      within(screen.getByTestId("context-menu"))
        .getAllByRole("button")
        .map((button) => button.textContent);

    fireEvent.contextMenu(screen.getByTestId("gps-map-overview-grid"));
    const overviewMenu = screen.getByTestId("context-menu");
    expect(
      within(overviewMenu).getByRole("button", { name: "Edit GPS…" }),
    ).toBeEnabled();
    expect(
      within(overviewMenu).getByRole("button", {
        name: "Discard all 2 GPS edits…",
      }),
    ).toBeEnabled();
    expect(
      within(overviewMenu).getByRole("button", { name: expectedRemoveLabel }),
    ).toBeEnabled();
    const overviewLabels = optionLabels();

    fireEvent.mouseDown(document.body);
    fireEvent.contextMenu(gpsHeading());
    expect(optionLabels()).toEqual(overviewLabels);

    fireEvent.click(
      within(screen.getByTestId("context-menu")).getByRole("button", {
        name: "Edit GPS…",
      }),
    );
    expect(await screen.findByText("Edit GPS location")).toBeInTheDocument();
  });

  it("keeps non-GPS group menus unchanged", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": 0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
      "IFD0:Make": "Canon",
    });
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(metadata)}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    const section = screen.getByTestId("details-section-IFD0");
    fireEvent.contextMenu(
      within(section).getByRole("heading", { name: "IFD0", level: 3 }),
    );
    const menu = screen.getByTestId("context-menu");
    expect(within(menu).queryByText("Edit GPS…")).toBeNull();
    expect(within(menu).getByRole("button", { name: /Remove/ })).toBeEnabled();
  });

  it("disables Edit GPS when the composite callback is unavailable", () => {
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(validGpsMetadata())}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    fireEvent.contextMenu(gpsHeading());
    const menu = screen.getByTestId("context-menu");
    const editGps = within(menu).getByRole("button", { name: "Edit GPS…" });
    expect(editGps).toBeDisabled();
    expect(editGps).toHaveAttribute(
      "title",
      "Target-aware GPS editing is unavailable in this view. Nothing was saved.",
    );
    expect(within(menu).getByRole("button", { name: /Remove/ })).toBeEnabled();
  });

  it("shows planner-blocked GPS editing without allowing the editor to open", () => {
    const occurrences = occurrencesFor(validGpsMetadata());
    const latitude = occurrences.find(
      (occurrence) => occurrence.tag_info?.name === "GPSLatitude",
    )!;
    occurrences.push({
      ...structuredClone(latitude),
      id: { ...latitude.id, copy: 1 },
    });

    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrences}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    fireEvent.contextMenu(gpsHeading());
    const edit = within(screen.getByTestId("context-menu")).getByRole(
      "button",
      { name: "Edit GPS…" },
    );
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute(
      "title",
      expect.stringMatching(/Several authoritative occurrences/),
    );
    fireEvent.click(edit);
    expect(screen.queryByText("Edit GPS location")).toBeNull();
  });

  it("blocks GPS editing when target-draft persistence is unsafe", () => {
    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrencesFor(validGpsMetadata())}
        targetDraftPersistence={{ status: "load-failed", error: "invalid" }}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
      />,
    );

    fireEvent.contextMenu(gpsHeading());
    const edit = within(screen.getByTestId("context-menu")).getByRole(
      "button",
      { name: "Edit GPS…" },
    );
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute(
      "title",
      expect.stringMatching(/persistence did not load safely/),
    );
  });

  it("counts and discards only complete exact GPS draft targets", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": 0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
      "IFD0:Make": "Canon",
    });
    const occurrences = occurrencesFor(metadata);
    const latitude = occurrences.find(
      (occurrence) => occurrence.tag_info?.name === "GPSLatitude",
    )!;
    const make = occurrences.find(
      (occurrence) => occurrence.tag_info?.name === "Make",
    )!;
    const latitudeTarget = existingOccurrenceTargetFromOccurrence(latitude);
    const makeTarget = existingOccurrenceTargetFromOccurrence(make);
    if (
      latitudeTarget.kind !== "targetable" ||
      makeTarget.kind !== "targetable"
    ) {
      throw new Error("test occurrences must be targetable");
    }
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch(photo.relative_path, [
      {
        target: latitudeTarget.target,
        edit: { intent: "Set", value: { kind: "Real", value: 52 } },
      },
      {
        target: makeTarget.target,
        edit: { intent: "Set", value: { kind: "Text", value: "Nikon" } },
      },
    ]);
    const onDiscardTargetDraftBatch = vi.fn(() => true);

    render(
      <DetailsPane
        photo={photo}
        occurrences={occurrences}
        targetDraftEdits={store.getMetadataFile(photo.relative_path)}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={onDiscardTargetDraftBatch}
      />,
    );

    fireEvent.contextMenu(gpsHeading());
    fireEvent.click(
      within(screen.getByTestId("context-menu")).getByRole("button", {
        name: "Discard 1 GPS edit…",
      }),
    );

    await waitFor(() => expect(onDiscardTargetDraftBatch).toHaveBeenCalled());
    expect(askMock).toHaveBeenCalledWith(
      expect.stringContaining("Discard 1 pending GPS field edit"),
      expect.objectContaining({ title: "Discard GPS Edits" }),
    );
    expect(onDiscardTargetDraftBatch).toHaveBeenCalledWith([
      latitudeTarget.target,
    ]);
  });

  it("renders the map overview when a GPS section exists and coordinates resolve to valid values", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(
      <DetailsPane
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrencesFromMetadataCollection(metadata)}
      />,
    );

    const overview = screen.getByTestId("gps-map-overview");
    expect(overview).toBeInTheDocument();

    const maps = screen.getAllByTestId("gps-map");
    expect(maps).toHaveLength(4);
    for (const map of maps) {
      expect(map.getAttribute("data-lat")).toBe("51.5001");
      expect(map.getAttribute("data-lon")).toBe("-0.1262");
    }
  });

  it("does not render the map overview when no GPS metadata/group exists", () => {
    const metadata = mockMetadata({
      "IFD0:Make": "Canon",
    });

    render(
      <DetailsPane
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrencesFromMetadataCollection(metadata)}
      />,
    );

    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gps-map")).not.toBeInTheDocument();
  });

  it("does not render the map overview when a GPS section exists but valid lat/lon cannot both be resolved", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitudeRef": "N", // No latitude/longitude values
    });

    render(
      <DetailsPane
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrencesFromMetadataCollection(metadata)}
      />,
    );

    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
  });

  it("moves the marker for exact target-aware GPS drafts and hides it for an exact Delete", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": 0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });
    const occurrences = occurrencesFor(metadata);
    const latitude = occurrences.find(
      (item) => item.tag_info?.name === "GPSLatitude",
    )!;
    const longitude = occurrences.find(
      (item) => item.tag_info?.name === "GPSLongitude",
    )!;
    const latitudeTarget = existingOccurrenceTargetFromOccurrence(latitude);
    const longitudeTarget = existingOccurrenceTargetFromOccurrence(longitude);
    if (
      latitudeTarget.kind !== "targetable" ||
      longitudeTarget.kind !== "targetable"
    ) {
      throw new Error("test GPS occurrences must be targetable");
    }
    const store = new TargetDraftEditsStore();
    store.setMetadataBatch(photo.relative_path, [
      {
        target: latitudeTarget.target,
        edit: { intent: "Set", value: { kind: "Real", value: 48.8584 } },
      },
      {
        target: longitudeTarget.target,
        edit: { intent: "Set", value: { kind: "Real", value: 2.2945 } },
      },
    ]);
    const baseProps = {
      onRemoveMetadataFields: vi.fn(),
      onApplyGpsTargetDraftBatch: vi.fn(() => true),
      onDiscardTargetDraftBatch: vi.fn(),
      photo,
      occurrences,
    };
    const rendered = render(
      <DetailsPane
        {...baseProps}
        targetDraftEdits={store.getMetadataFile(photo.relative_path)}
      />,
    );
    for (const map of screen.getAllByTestId("gps-map")) {
      expect(map).toHaveAttribute("data-lat", "48.8584");
      expect(map).toHaveAttribute("data-lon", "-2.2945");
    }

    store.setMetadataTarget(photo.relative_path, latitudeTarget.target, {
      intent: "Delete",
      value: null,
    });
    rendered.rerender(
      <DetailsPane
        {...baseProps}
        targetDraftEdits={store.getMetadataFile(photo.relative_path)}
      />,
    );
    expect(screen.queryByTestId("gps-map-overview")).not.toBeInTheDocument();
  });

  it("keeps map-visible and generated geocode coordinates equivalent across draft states", () => {
    const baseMetadata = () =>
      mockMetadata({
        "GPS:GPSLatitude": 51,
        "GPS:GPSLatitudeRef": "N",
        "GPS:GPSLongitude": 1,
        "GPS:GPSLongitudeRef": "E",
        "Composite:GPSLatitude": 51,
        "Composite:GPSLongitude": 1,
      });
    const exactEntry = (
      occurrence: MetadataOccurrence,
      edit: MetadataDraftEdit,
    ): MetadataTargetDraftEntry => {
      const target = existingOccurrenceTargetFromOccurrence(occurrence);
      if (target.kind !== "targetable") throw new Error(target.reason);
      return { target: target.target, edit };
    };
    const targetCollection = (
      ...entries: MetadataTargetDraftEntry[]
    ): TargetDraftCollection =>
      Object.fromEntries(entries.map((entry, index) => [String(index), entry]));
    const find = (occurrences: MetadataOccurrence[], tagId: string) =>
      occurrences.find((item) => item.tag_info?.id.tag_id === tagId)!;

    const noDraftMetadata = baseMetadata();
    const noDraftOccurrences = occurrencesFor(noDraftMetadata);

    const targetMetadata = baseMetadata();
    const targetOccurrences = occurrencesFor(targetMetadata);
    const draftTargets = targetCollection(
      exactEntry(find(targetOccurrences, GPS_IDS.latitude.tag_id), {
        intent: "Set",
        value: { kind: "Real", value: 52 },
      }),
      exactEntry(find(targetOccurrences, GPS_IDS.longitude.tag_id), {
        intent: "Set",
        value: { kind: "Real", value: 2 },
      }),
      exactEntry(find(targetOccurrences, GPS_IDS.longitudeRef.tag_id), {
        intent: "Set",
        value: { kind: "Text", value: "W" },
      }),
    );

    const missingRefMetadata = mockMetadata({
      "GPS:GPSLatitude": 51,
      "GPS:GPSLongitude": 1,
    });
    const missingRefOccurrences = occurrencesFor(missingRefMetadata);
    const missingRefTargets = targetCollection(
      {
        target: {
          kind: "NewProperty",
          schema_id: GPS_IDS.latitudeRef,
          write_target: {
            group1: "XMP-test",
            group7: "ID-Test",
            tag_name: "TestTag",
          },
        },
        edit: { intent: "Set", value: { kind: "Text", value: "S" } },
      },
      {
        target: {
          kind: "NewProperty",
          schema_id: GPS_IDS.longitudeRef,
          write_target: {
            group1: "XMP-test",
            group7: "ID-Test",
            tag_name: "TestTag",
          },
        },
        edit: { intent: "Set", value: { kind: "Text", value: "W" } },
      },
    );

    const refMetadata = baseMetadata();
    const refOccurrences = occurrencesFor(refMetadata);
    const refTargets = targetCollection(
      exactEntry(find(refOccurrences, GPS_IDS.latitudeRef.tag_id), {
        intent: "Set",
        value: { kind: "Text", value: "S" },
      }),
      exactEntry(find(refOccurrences, GPS_IDS.longitudeRef.tag_id), {
        intent: "Set",
        value: { kind: "Text", value: "W" },
      }),
    );

    const deleteMetadata = baseMetadata();
    const deleteOccurrences = occurrencesFor(deleteMetadata);
    const deleteTargets = targetCollection(
      exactEntry(find(deleteOccurrences, GPS_IDS.latitude.tag_id), {
        intent: "Delete",
        value: null,
      }),
    );

    const staleMetadata = baseMetadata();
    const staleOccurrences = occurrencesFor(staleMetadata);
    const stale = exactEntry(find(staleOccurrences, GPS_IDS.latitude.tag_id), {
      intent: "Set",
      value: { kind: "Real", value: 60 },
    });
    if (stale.target.kind !== "ExistingOccurrence") {
      throw new Error("Expected ExistingOccurrence target");
    }
    stale.target = {
      ...stale.target,
      occurrence_id: { ...stale.target.occurrence_id, copy: 99 },
    };

    const multipleMetadata = baseMetadata();
    const multipleOccurrences = occurrencesFor(multipleMetadata);
    const latitude = find(multipleOccurrences, GPS_IDS.latitude.tag_id);
    multipleOccurrences.push({
      ...structuredClone(latitude),
      id: { ...latitude.id, copy: 1 },
      value: { kind: "Real", value: 70 },
    });
    const multipleTargets = targetCollection(
      exactEntry(latitude, {
        intent: "Set",
        value: { kind: "Real", value: 60 },
      }),
    );

    const scenarios: Array<{
      name: string;
      metadata: ReturnType<typeof mockMetadata>;
      occurrences: MetadataOccurrence[];
      targetDrafts?: TargetDraftCollection;
      expected: { lat: number | null; lon: number | null };
    }> = [
      {
        name: "no drafts",
        metadata: noDraftMetadata,
        occurrences: noDraftOccurrences,
        expected: { lat: 51, lon: 1 },
      },
      {
        name: "target-aware existing-coordinate drafts",
        metadata: targetMetadata,
        occurrences: targetOccurrences,
        targetDrafts: draftTargets,
        expected: { lat: 52, lon: -2 },
      },
      {
        name: "target-aware missing-reference NewProperty drafts",
        metadata: missingRefMetadata,
        occurrences: missingRefOccurrences,
        targetDrafts: missingRefTargets,
        expected: { lat: -51, lon: -1 },
      },
      {
        name: "southern/western reference drafts",
        metadata: refMetadata,
        occurrences: refOccurrences,
        targetDrafts: refTargets,
        expected: { lat: -51, lon: -1 },
      },
      {
        name: "target-aware coordinate Delete",
        metadata: deleteMetadata,
        occurrences: deleteOccurrences,
        targetDrafts: deleteTargets,
        expected: { lat: null, lon: null },
      },
      {
        name: "stale target-aware target",
        metadata: staleMetadata,
        occurrences: staleOccurrences,
        targetDrafts: targetCollection(stale),
        expected: { lat: 51, lon: 1 },
      },
      {
        name: "multiply-resolved GPS",
        metadata: multipleMetadata,
        occurrences: multipleOccurrences,
        targetDrafts: multipleTargets,
        expected: { lat: 51, lon: 1 },
      },
    ];

    for (const scenario of scenarios) {
      cleanup();
      const item = buildGeocodeRequestItemForFile(photo.relative_path, {
        occurrences: scenario.occurrences,
        targetDrafts: scenario.targetDrafts,
      });
      expect(item, scenario.name).toEqual({
        relPath: photo.relative_path,
        ...scenario.expected,
      });

      render(
        <DetailsPane
          onRemoveMetadataFields={vi.fn()}
          onApplyGpsTargetDraftBatch={vi.fn(() => true)}
          onDiscardTargetDraftBatch={vi.fn()}
          photo={photo}

          occurrences={scenario.occurrences}
          targetDraftEdits={scenario.targetDrafts}
        />,
      );
      if (scenario.expected.lat === null || scenario.expected.lon === null) {
        expect(
          screen.queryByTestId("gps-map-overview"),
          scenario.name,
        ).not.toBeInTheDocument();
      } else {
        const maps = screen.getAllByTestId("gps-map");
        expect(maps, scenario.name).toHaveLength(4);
        for (const map of maps) {
          expect(map, scenario.name).toHaveAttribute(
            "data-lat",
            String(item.lat),
          );
          expect(map, scenario.name).toHaveAttribute(
            "data-lon",
            String(item.lon),
          );
        }
      }
    }
  });

  it("keeps map and geocode at zero while the editor preserves S/W references", async () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 0,
      "GPS:GPSLatitudeRef": "S",
      "GPS:GPSLongitude": 0,
      "GPS:GPSLongitudeRef": "W",
    });
    const occurrences = occurrencesFor(metadata);
    const geocodeItem = buildGeocodeRequestItemForFile(photo.relative_path, {
      occurrences,
      targetDrafts: undefined,
    });

    expect(geocodeItem.lat === 0).toBe(true);
    expect(geocodeItem.lon === 0).toBe(true);

    render(
      <DetailsPane
        onRemoveMetadataFields={vi.fn()}
        onApplyGpsTargetDraftBatch={vi.fn(() => true)}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}

        occurrences={occurrences}
      />,
    );

    for (const map of screen.getAllByTestId("gps-map")) {
      expect(map).toHaveAttribute("data-lat", "0");
      expect(map).toHaveAttribute("data-lon", "0");
    }

    const latitudeRow = screen
      .getAllByTestId("details-row")
      .find((row) => within(row).queryByText("GPSLatitude") !== null);
    expect(latitudeRow).toBeDefined();
    fireEvent.contextMenu(latitudeRow!);
    fireEvent.click(screen.getByRole("button", { name: "Edit GPS…" }));

    expect(await screen.findByTestId("gps-editor-lat-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lat-ref")).toHaveValue("S");
    expect(screen.getByTestId("gps-editor-lon-input")).toHaveValue(0);
    expect(screen.getByTestId("gps-editor-lon-ref")).toHaveValue("W");
  });

  it("verifies DOM order: GPS section heading, then map overview, then first GPS row", () => {
    const metadata = mockMetadata({
      "GPS:GPSLatitude": 51.5001,
      "GPS:GPSLongitude": -0.1262,
      "GPS:GPSLatitudeRef": "N",
      "GPS:GPSLongitudeRef": "W",
    });

    render(
      <DetailsPane
        onRemoveMetadataFields={vi.fn()}
        onDiscardTargetDraftBatch={vi.fn()}
        photo={photo}
        occurrences={occurrencesFromMetadataCollection(metadata)}
      />,
    );

    const gpsSection = screen.getByTestId("details-section-GPS");
    expect(gpsSection).toBeInTheDocument();

    const heading = gpsSection.querySelector(".details-section-header");
    const overview = gpsSection.querySelector(
      '[data-testid="gps-map-overview"]',
    );
    const table = gpsSection.querySelector(".details-table");

    expect(heading).toBeInTheDocument();
    expect(overview).toBeInTheDocument();
    expect(table).toBeInTheDocument();

    // Verify DOM order: heading is followed by overview, followed by table
    const children = Array.from(gpsSection.childNodes);
    const headingIndex = children.indexOf(heading!);
    const overviewIndex = children.indexOf(overview!);
    const tableIndex = children.indexOf(table!);

    expect(headingIndex).toBeLessThan(overviewIndex);
    expect(overviewIndex).toBeLessThan(tableIndex);
  });
});

describe("GpsMapOverview component", () => {
  beforeEach(() => {
    cleanup();
  });

  it("renders four GpsMap components with correct props", () => {
    render(<GpsMapOverview lat={34.0522} lon={-118.2437} />);

    const maps = screen.getAllByTestId("gps-map");
    expect(maps).toHaveLength(4);

    // Verify World map
    expect(maps[0].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[0].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[0].getAttribute("data-zoom")).toBe("1");
    expect(maps[0].getAttribute("data-show-attribution")).toBe("false");

    // Verify Country map
    expect(maps[1].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[1].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[1].getAttribute("data-zoom")).toBe("4");
    expect(maps[1].getAttribute("data-show-attribution")).toBe("false");

    // Verify City map
    expect(maps[2].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[2].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[2].getAttribute("data-zoom")).toBe("8");
    expect(maps[2].getAttribute("data-show-attribution")).toBe("false");

    // Verify Local map
    expect(maps[3].getAttribute("data-lat")).toBe("34.0522");
    expect(maps[3].getAttribute("data-lon")).toBe("-118.2437");
    expect(maps[3].getAttribute("data-zoom")).toBe("16");
    expect(maps[3].getAttribute("data-show-attribution")).toBe("false");

    // Verify separate attribution row
    expect(screen.getByText(/OpenStreetMap/)).toBeInTheDocument();
  });

  it("does not suppress native grid context menus without a callback", () => {
    render(<GpsMapOverview lat={34.0522} lon={-118.2437} />);
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });

    screen.getByTestId("gps-map-overview-grid").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves attribution links outside the custom grid context-menu surface", () => {
    const onContextMenu = vi.fn((event: React.MouseEvent) =>
      event.preventDefault(),
    );
    render(
      <GpsMapOverview
        lat={34.0522}
        lon={-118.2437}
        onContextMenu={onContextMenu}
      />,
    );
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });

    screen.getByRole("link", { name: "OpenStreetMap" }).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onContextMenu).not.toHaveBeenCalled();
  });

  it("does nothing on an ordinary left-click of the grid", () => {
    const onContextMenu = vi.fn();
    render(
      <GpsMapOverview
        lat={34.0522}
        lon={-118.2437}
        onContextMenu={onContextMenu}
      />,
    );

    fireEvent.click(screen.getByTestId("gps-map-overview-grid"));

    expect(onContextMenu).not.toHaveBeenCalled();
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });
});

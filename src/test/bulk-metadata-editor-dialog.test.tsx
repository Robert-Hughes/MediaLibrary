import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BulkMetadataEditorDialog } from "../components/BulkMetadataEditorDialog";
import type { BulkMetadataDraftRequest } from "../bulkMetadataDrafts";
import type { SchemaDefinitionId, TagInfo } from "../types";
import {
  occurrenceFromSchemaValue,
  occurrenceStore,
} from "./occurrenceFixtures";
import { makePhotos } from "./factories";
import {
  _resetWritableSchemaDefinitionsCache,
  _setWritableSchemaDefinitionsCache,
} from "../hooks/useWritableSchemaDefinitions";
import { _setTagInfoCacheEntry } from "../hooks/useTagInfo";
import { GPS_IDS, knownMetadataWriteTarget } from "../metadata/knownIds";

const id: SchemaDefinitionId = { table: "XMP::dc", tag_id: "title" };
const info: TagInfo = {
  id,
  group: "XMP-dc",
  name: "Title",
  writable: true,
  kind: { kind: "Text" },
  description: "Title",
  storage_count: undefined,
};

const gpsInfos: TagInfo[] = Object.values(GPS_IDS).map((gpsId) => {
  const target = knownMetadataWriteTarget(gpsId)!;
  return {
    id: structuredClone(gpsId),
    group: target.group1,
    name: target.tag_name,
    writable: true,
    kind: { kind: "Real" },
    description: null,
  };
});

beforeEach(() => {
  for (const gpsInfo of gpsInfos) {
    _setTagInfoCacheEntry(gpsInfo.id, gpsInfo);
  }
});

afterEach(() => {
  _resetWritableSchemaDefinitionsCache();
});

describe("BulkMetadataEditorDialog", () => {
  it("uses TypedValueEditor to collect a semantic Set value", async () => {
    _setWritableSchemaDefinitionsCache([info]);
    _setTagInfoCacheEntry(id, info);
    let previewedRequest: BulkMetadataDraftRequest | undefined;
    const onPreview = vi.fn((request: BulkMetadataDraftRequest) => {
      previewedRequest = request;
      return {
        kind: "ready" as const,
        plan: {
          mutations: [],
          preview: {
            photoCount: 2,
            affectedPhotoCount: 2,
            noOpPhotoCount: 0,
            existingOccurrencesSet: 1,
            newPropertiesSet: 1,
            existingOccurrencesDeleted: 0,
            stagedCreationsCancelled: 0,
            draftsCleared: 0,
          },
        },
      };
    });
    const onStage = vi.fn((_request: BulkMetadataDraftRequest) => true);
    const onClose = vi.fn();
    const existing = occurrenceFromSchemaValue(
      id,
      { kind: "Text", value: "Old" },
      0,
    );
    existing.tag_info = info;

    render(
      <BulkMetadataEditorDialog
        photos={makePhotos(["one.jpg", "two.jpg"])}
        imageMetadataOccurrences={occurrenceStore({
          "one.jpg": [existing],
          "two.jpg": [],
        })}
        targetDraftEdits={{}}
        onPreview={onPreview}
        onStage={onStage}
        onClose={onClose}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /XMP-dc:Title/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "Enter value..." }),
    );

    expect(
      screen.getByText(/replace this property on all 2 selected photos/i),
    ).toBeInTheDocument();
    const input = screen.getByTestId("value-edit-input");
    await userEvent.clear(input);
    await userEvent.type(input, "New title");
    await userEvent.click(screen.getByTestId("value-edit-save"));

    expect(onPreview).toHaveBeenCalledWith({
      operation: "Set",
      tagInfo: info,
      edit: { intent: "Set", value: { kind: "Text", value: "New title" } },
      merge: false,
    });
    expect(screen.getByText("Set XMP-dc:Title")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Stage draft edits" }),
    );
    expect(onStage).toHaveBeenCalledWith(previewedRequest);
    expect(onClose).toHaveBeenCalled();
  });
  it("presents GPS as one grouped property without merge", async () => {
    _setWritableSchemaDefinitionsCache(gpsInfos);
    for (const gpsInfo of gpsInfos) {
      _setTagInfoCacheEntry(gpsInfo.id, gpsInfo);
    }
    const onPreview = vi.fn((_request: BulkMetadataDraftRequest) => ({
      kind: "ready" as const,
      plan: {
        mutations: [],
        preview: {
          photoCount: 1,
          affectedPhotoCount: 0,
          noOpPhotoCount: 1,
          existingOccurrencesSet: 0,
          newPropertiesSet: 0,
          existingOccurrencesDeleted: 0,
          stagedCreationsCancelled: 0,
          draftsCleared: 0,
        },
      },
    }));

    render(
      <BulkMetadataEditorDialog
        photos={makePhotos(["gps.jpg"])}
        imageMetadataOccurrences={occurrenceStore({ "gps.jpg": [] })}
        targetDraftEdits={{}}
        onPreview={onPreview}
        onStage={() => true}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /GPS Location/ }));
    expect(
      screen.queryByLabelText("Merge with existing value"),
    ).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText("Delete"));
    await userEvent.click(
      screen.getByRole("button", { name: "Review Delete" }),
    );

    expect(onPreview).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "DeleteGps" }),
    );
    expect(screen.getByText("Delete GPS Location")).toBeInTheDocument();
  });
});

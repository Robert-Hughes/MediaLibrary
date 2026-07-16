import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { TargetDraftEditsStore } from "../targetDraftEdits";
import { makePhoto, testId } from "./factories";
import { createMockTauriApi } from "./mockTauriApi";

let mockApi: ReturnType<typeof createMockTauriApi>;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string, args?: Record<string, unknown>) =>
    mockApi.api.invoke(command, args),
  convertFileSrc: (path: string) => path,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (event: { payload: unknown }) => void) =>
    mockApi.api.listen(event, (payload) => handler({ payload })),
}));

describe("list search target-draft projection", () => {
  beforeEach(() => {
    mockApi = createMockTauriApi();
  });

  it("finds a draft-only value by value, exact schema, friendly name, description, and has:edits", async () => {
    const cityId = testId("XMP-photoshop:City");
    mockApi.tagInfos = [
      {
        id: cityId,
        group: "XMP-photoshop",
        name: "City",
        writable: true,
        kind: { kind: "Text" },
        description: "City shown in the photograph",
      },
    ];
    const drafts = new TargetDraftEditsStore();
    drafts.setMetadataTarget(
      "draft.jpg",
      { kind: "NewProperty", schema_id: cityId },
      { intent: "Set", value: { kind: "Text", value: "Reykjavik draft" } },
    );
    mockApi.targetDraftEditsByFolder["/photos"] = drafts.getAllMetadata();
    mockApi.pickFolderResolves("/photos");

    const user = userEvent.setup();
    render(<App />);
    await screen.findByTestId("open-folder-btn");
    await user.click(screen.getByTestId("open-folder-btn"));
    act(() => {
      mockApi.emitPhotoFound(makePhoto({ relative_path: "draft.jpg" }));
      mockApi.emitPhotoFound(makePhoto({ relative_path: "plain.jpg" }));
      mockApi.emitScanComplete();
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("photo-row")).toHaveLength(2),
    );

    const search = screen.getByTestId("list-search-input");
    for (const query of [
      "Reykjavik draft",
      "XMP::photoshop",
      "XMP-photoshop:City",
      "City shown in the photograph",
      "has:edits",
    ]) {
      await user.clear(search);
      await user.type(search, query);
      await waitFor(() => {
        const rows = screen.getAllByTestId("photo-row");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toHaveTextContent("draft.jpg");
      });
    }
  });
});

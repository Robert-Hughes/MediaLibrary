import { describe, expect, it } from "vitest";
import { FileMetadataOccurrencesStore, MetadataProgressStore } from "../types";
import { projectSessionMetadata } from "../sessionMetadataProjection";

function stores() {
  return {
    occurrences: new FileMetadataOccurrencesStore(),
    progress: new MetadataProgressStore(),
  };
}

describe("session metadata projection", () => {
  it("projects loading, ready and failed states and counts completions once", () => {
    const projection = stores();
    projection.progress.setTotal(3);

    expect(
      projectSessionMetadata(
        [
          { relative_path: "loading.jpg", state: { status: "loading" } },
          {
            relative_path: "ready.jpg",
            state: { status: "ready", occurrences: [] },
          },
          {
            relative_path: "failed.jpg",
            state: { status: "failed", error: "broken" },
          },
        ],
        false,
        projection,
      ),
    ).toBe(1);
    expect(projection.occurrences.get("loading.jpg")).toBe("loading");
    expect(projection.occurrences.get("ready.jpg")).toEqual([]);
    expect(projection.occurrences.get("failed.jpg")).toBe("failed");
    expect(projection.occurrences.getFailure("failed.jpg")).toBe("broken");
    expect(projection.progress.getRemaining()).toBe(1);

    projectSessionMetadata(
      [
        {
          relative_path: "ready.jpg",
          state: { status: "ready", occurrences: [] },
        },
      ],
      false,
      projection,
    );
    expect(projection.progress.getRemaining()).toBe(1);
  });

  it("rebuilds projection state when reset is requested", () => {
    const projection = stores();
    projection.occurrences.add("stale.jpg");
    projection.progress.setTotal(5);
    projection.progress.incrementReceived(4);

    projectSessionMetadata(
      [
        {
          relative_path: "fresh.jpg",
          state: { status: "ready", occurrences: [] },
        },
      ],
      true,
      projection,
    );

    expect(projection.occurrences.has("stale.jpg")).toBe(false);
    expect(projection.occurrences.get("fresh.jpg")).toEqual([]);
    expect(projection.progress.getTotal()).toBe(0);
    expect(projection.progress.getRemaining()).toBe(0);
  });
});

/**
 * Integration tests for list search: filter, empty state, highlights in
 * visible cells.  Drives the same search pipeline the production app
 * uses — `useSearchWorker` + the SearchIndex-backed InThreadSearchWorker
 * stub from `src/test/setup.ts`.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useState } from "react";
import { describe, it, expect } from "vitest";
import { PhotoList } from "../components/PhotoList";
import { DraftEditsStore, ImageMetadataStore, ThumbnailStore } from "../types";
import { makePhotos, imgCol } from "./factories";
import { useSearchWorker, createSearchWorker } from "../hooks/useSearchWorker";

const defaultSortProps = {
  sortConfig: { primary: null, secondary: null } as const,
  onSortChange: () => {},
};

function ListSearchHarness({
  allPhotos,
  visibleColumns,
}: {
  allPhotos: ReturnType<typeof makePhotos>;
  visibleColumns: Array<{ key: string; kind: "os" | "image" }>;
}) {
  const [query, setQuery] = useState("");
  const thumbs = useMemo(() => {
    const s = new ThumbnailStore();
    allPhotos.forEach((p) => {
      s.add(p.relative_path);
      s.set(p.relative_path, "x");
    });
    return s;
  }, [allPhotos]);
  const meta = useMemo(() => {
    const m = new ImageMetadataStore();
    allPhotos.forEach((p) => m.add(p.relative_path));
    m.set("a.jpg", { "Hidden:SecretTag": "unique-xyz-123", "IFD0:Make": "Sony" });
    m.set("b.jpg", { "IFD0:Make": "Canon" });
    m.set("c.jpg", { "IFD0:Make": "Nikon" });
    return m;
  }, [allPhotos]);
  const drafts = useMemo(() => new DraftEditsStore(), []);

  const { matched } = useSearchWorker({
    photos: allPhotos,
    imageMetadataStore: meta,
    draftEditsStore: drafts,
    query,
    debounceMs: 0,
    createWorker: createSearchWorker,
  });

  const display = useMemo(
    () => matched === null ? allPhotos : allPhotos.filter((p) => matched.has(p.relative_path)),
    [allPhotos, matched],
  );

  return (
    <>
      <input
        data-testid="list-search-input"
        aria-label="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <PhotoList
        photos={display}
        thumbnails={thumbs}
        imageMetadata={meta}
        visibleColumns={visibleColumns}
        {...defaultSortProps}
        selectedIndex={null}
        onSelect={() => {}}
        onShowInExplorer={() => {}}
        onVisibilityChange={() => {}}
        onPhotoOpen={() => {}}
        onSelectColumns={() => {}}
        searchQuery={query}
        emptySearchMessage={
          query.trim() && allPhotos.length > 0 && display.length === 0 ? "No photos match your search." : null
        }
      />
    </>
  );
}

describe("List view search", () => {
  const photos = makePhotos(["a.jpg", "b.jpg", "c.jpg"]).map((p) => ({
    ...p,
    date_modified: 1_700_000_000,
    date_created: 1_700_000_000,
  }));

  it("filters rows by path and highlights the match in the path cell", async () => {
    render(
      <ListSearchHarness
        allPhotos={photos}
        visibleColumns={[{ key: "date_modified", kind: "os" }]}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
    });

    await userEvent.type(screen.getByTestId("list-search-input"), "b.jpg");

    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(1);
    });
    const rows = screen.getAllByTestId("photo-row");
    const pathCell = within(rows[0].querySelector('[data-testid="photo-path"]') as HTMLElement).getByText(/b\.jpg/i);
    expect(pathCell.closest("mark")).toHaveClass("search-highlight");
  });

  it("keeps a row when only hidden metadata matches and does not highlight the path cell", async () => {
    render(
      <ListSearchHarness allPhotos={photos} visibleColumns={[imgCol("IFD0:Make")]} />,
    );

    await userEvent.type(screen.getByTestId("list-search-input"), "unique-xyz-123");

    await waitFor(() => {
      expect(screen.getAllByTestId("photo-row")).toHaveLength(1);
    });
    const rows = screen.getAllByTestId("photo-row");
    expect(rows[0]).toHaveAttribute("data-path", "a.jpg");

    const path = within(rows[0].querySelector('[data-testid="photo-path"]') as HTMLElement);
    expect(path.queryAllByRole("mark")).toHaveLength(0);

    const makeCell = rows[0].querySelector('[data-col="IFD0:Make"]') as HTMLElement;
    expect(makeCell).not.toBeNull();
    expect(within(makeCell).queryAllByRole("mark")).toHaveLength(0);
  });

  it("shows empty-search message when filter excludes all photos", async () => {
    render(
      <ListSearchHarness allPhotos={photos} visibleColumns={[{ key: "date_modified", kind: "os" }]} />,
    );

    await userEvent.type(screen.getByTestId("list-search-input"), "no-such-match-zzzz");

    await waitFor(() => {
      expect(screen.getByTestId("photo-list-search-empty")).toBeInTheDocument();
    });
    expect(screen.getByTestId("photo-list-search-empty-message")).toHaveTextContent("No photos match your search.");
  });
});

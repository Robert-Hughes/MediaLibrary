/**
 * Component rendering tests.
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { MenuBar } from "../components/MenuBar";
import { PhotoList } from "../components/PhotoList";
import { ThumbnailStore } from "../types";
import type { PhotoInfo } from "../types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStore(photos: PhotoInfo[], overrides: Record<string, string> = {}): ThumbnailStore {
  const store = new ThumbnailStore();
  store.reset(photos.map((p) => p.relative_path));
  for (const [path, value] of Object.entries(overrides)) {
    store.set(path, value);
  }
  return store;
}

// ── WelcomeScreen ─────────────────────────────────────────────────────────────

describe("WelcomeScreen", () => {
  it("renders the title and open button", () => {
    render(<WelcomeScreen onOpenFolder={() => {}} />);
    expect(screen.getByText("Media Library")).toBeInTheDocument();
    expect(screen.getByTestId("open-folder-btn")).toBeInTheDocument();
  });

  it("calls onOpenFolder when the button is clicked", async () => {
    const handler = vi.fn();
    render(<WelcomeScreen onOpenFolder={handler} />);
    await userEvent.click(screen.getByTestId("open-folder-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── LoadingScreen ─────────────────────────────────────────────────────────────

describe("LoadingScreen", () => {
  it("shows the folder path", () => {
    render(<LoadingScreen folder="/photos/vacation" foundSoFar={0} />);
    expect(screen.getByTestId("loading-folder")).toHaveTextContent("/photos/vacation");
  });

  it("shows searching message when foundSoFar is 0", () => {
    render(<LoadingScreen folder="/photos" foundSoFar={0} />);
    expect(screen.getByTestId("loading-progress")).toHaveTextContent("Searching for photos");
  });

  it("shows count when photos have been found", () => {
    render(<LoadingScreen folder="/photos" foundSoFar={42} />);
    expect(screen.getByTestId("loading-progress")).toHaveTextContent("42 photos found so far");
  });

  it("uses singular 'photo' when count is 1", () => {
    render(<LoadingScreen folder="/photos" foundSoFar={1} />);
    expect(screen.getByTestId("loading-progress")).toHaveTextContent("1 photo found so far");
  });
});

// ── MenuBar ───────────────────────────────────────────────────────────────────

describe("MenuBar", () => {
  const defaultProps = {
    photoCount: 3,
    onOpenFolder: () => {},
    onCloseFolder: () => {},
  };

  it("shows the photo count", () => {
    render(<MenuBar {...defaultProps} />);
    expect(screen.getByTestId("menu-bar-count")).toHaveTextContent("3 photos");
  });

  it("uses singular 'photo' when count is 1", () => {
    render(<MenuBar {...defaultProps} photoCount={1} />);
    expect(screen.getByTestId("menu-bar-count")).toHaveTextContent("1 photo");
  });

  it("calls onCloseFolder when close button is clicked", async () => {
    const handler = vi.fn();
    render(<MenuBar {...defaultProps} onCloseFolder={handler} />);
    await userEvent.click(screen.getByTestId("menu-bar-close-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("calls onOpenFolder when open button is clicked", async () => {
    const handler = vi.fn();
    render(<MenuBar {...defaultProps} onOpenFolder={handler} />);
    await userEvent.click(screen.getByTestId("menu-bar-open-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── PhotoList ─────────────────────────────────────────────────────────────────

describe("PhotoList", () => {
  const noop = () => {};

  it("shows empty message when there are no photos", () => {
    const store = new ThumbnailStore();
    render(<PhotoList photos={[]} thumbnails={store} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-list-empty")).toBeInTheDocument();
  });

  it("renders a row for each photo", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "a.jpg" },
      { relative_path: "b/c.png" },
      { relative_path: "d.gif" },
    ];
    render(<PhotoList photos={photos} thumbnails={makeStore(photos)} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
  });

  it("displays the relative path for each photo", () => {
    const photos: PhotoInfo[] = [{ relative_path: "vacation/beach.jpg" }];
    render(<PhotoList photos={photos} thumbnails={makeStore(photos)} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(screen.getByTestId("photo-path")).toHaveTextContent("vacation/beach.jpg");
  });

  it("renders a spinner when thumbnail is loading", () => {
    const photos: PhotoInfo[] = [{ relative_path: "a.jpg" }];
    render(<PhotoList photos={photos} thumbnails={makeStore(photos)} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(document.querySelector(".photo-thumb-spinner")).toBeInTheDocument();
    expect(document.querySelector(".photo-thumb-placeholder")).not.toBeInTheDocument();
  });

  it("renders a thumbnail img when thumbnail data is present", () => {
    const photos: PhotoInfo[] = [{ relative_path: "a.jpg" }];
    const store = makeStore(photos, { "a.jpg": "abc123" });
    render(<PhotoList photos={photos} thumbnails={store} onVisibilityChange={noop} onPhotoOpen={noop} />);
    const img = document.querySelector(".photo-thumb-img") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,abc123");
  });

  it("renders a placeholder when thumbnail has failed", () => {
    const photos: PhotoInfo[] = [{ relative_path: "a.jpg" }];
    const store = makeStore(photos, { "a.jpg": "failed" });
    render(<PhotoList photos={photos} thumbnails={store} onVisibilityChange={noop} onPhotoOpen={noop} />);
    expect(document.querySelector(".photo-thumb-placeholder")).toBeInTheDocument();
    expect(document.querySelector(".photo-thumb-spinner")).not.toBeInTheDocument();
  });

  it("sets data-path attribute on each row for IntersectionObserver", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "vacation/beach.jpg" },
      { relative_path: "portrait.png" },
    ];
    render(<PhotoList photos={photos} thumbnails={makeStore(photos)} onVisibilityChange={noop} onPhotoOpen={noop} />);
    const rows = screen.getAllByTestId("photo-row");
    expect(rows[0]).toHaveAttribute("data-path", "vacation/beach.jpg");
    expect(rows[1]).toHaveAttribute("data-path", "portrait.png");
  });

  it("calls onVisibilityChange when IntersectionObserver fires", () => {
    const observed: Element[] = [];
    const callbacks: IntersectionObserverCallback[] = [];

    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { callbacks.push(cb); }
      observe(el: Element) { observed.push(el); }
      disconnect() {}
    });

    const handler = vi.fn();
    const photos: PhotoInfo[] = [
      { relative_path: "a.jpg" },
      { relative_path: "b.jpg" },
    ];
    render(<PhotoList photos={photos} thumbnails={makeStore(photos)} onVisibilityChange={handler} onPhotoOpen={noop} />);

    const entries = observed.map((el) => ({
      target: el,
      isIntersecting: true,
    })) as IntersectionObserverEntry[];

    callbacks[0](entries, {} as IntersectionObserver);

    expect(handler).toHaveBeenCalledWith(expect.arrayContaining(["a.jpg", "b.jpg"]));

    vi.unstubAllGlobals();
  });

  it("row updates when store is mutated externally", async () => {
    const photos: PhotoInfo[] = [{ relative_path: "a.jpg" }];
    const store = makeStore(photos);

    const { rerender } = render(
      <PhotoList photos={photos} thumbnails={store} onVisibilityChange={noop} onPhotoOpen={noop} />
    );

    expect(document.querySelector(".photo-thumb-spinner")).toBeInTheDocument();

    // Simulate a thumbnail_ready event updating the store.
    act(() => { store.set("a.jpg", "newthumbdata"); });

    rerender(<PhotoList photos={photos} thumbnails={store} onVisibilityChange={noop} onPhotoOpen={noop} />);

    const img = document.querySelector(".photo-thumb-img") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,newthumbdata");
  });
});

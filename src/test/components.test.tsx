/**
 * Component rendering tests.
 * Verifies that each screen renders the right content for its props.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import { WelcomeScreen } from "../components/WelcomeScreen";
import { LoadingScreen } from "../components/LoadingScreen";
import { Toolbar } from "../components/Toolbar";
import { PhotoList } from "../components/PhotoList";
import type { PhotoInfo } from "../types";

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

// ── Toolbar ───────────────────────────────────────────────────────────────────

describe("Toolbar", () => {
  const defaultProps = {
    folder: "/photos/vacation",
    photoCount: 3,
    onOpenFolder: () => {},
    onCloseFolder: () => {},
  };

  it("shows the folder path", () => {
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByTestId("toolbar-folder")).toHaveTextContent("/photos/vacation");
  });

  it("shows the photo count", () => {
    render(<Toolbar {...defaultProps} />);
    expect(screen.getByTestId("toolbar-count")).toHaveTextContent("3 photos");
  });

  it("uses singular 'photo' when count is 1", () => {
    render(<Toolbar {...defaultProps} photoCount={1} />);
    expect(screen.getByTestId("toolbar-count")).toHaveTextContent("1 photo");
  });

  it("calls onCloseFolder when close button is clicked", async () => {
    const handler = vi.fn();
    render(<Toolbar {...defaultProps} onCloseFolder={handler} />);
    await userEvent.click(screen.getByTestId("toolbar-close-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("calls onOpenFolder when open button is clicked", async () => {
    const handler = vi.fn();
    render(<Toolbar {...defaultProps} onOpenFolder={handler} />);
    await userEvent.click(screen.getByTestId("toolbar-open-btn"));
    expect(handler).toHaveBeenCalledOnce();
  });
});

// ── PhotoList ─────────────────────────────────────────────────────────────────

describe("PhotoList", () => {
  const noop = () => {};

  it("shows empty message when there are no photos", () => {
    render(<PhotoList photos={[]} onVisibilityChange={noop} />);
    expect(screen.getByTestId("photo-list-empty")).toBeInTheDocument();
  });

  it("renders a row for each photo", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "a.jpg", thumbnail: null },
      { relative_path: "b/c.png", thumbnail: null },
      { relative_path: "d.gif", thumbnail: null },
    ];
    render(<PhotoList photos={photos} onVisibilityChange={noop} />);
    expect(screen.getAllByTestId("photo-row")).toHaveLength(3);
  });

  it("displays the relative path for each photo", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "vacation/beach.jpg", thumbnail: null },
    ];
    render(<PhotoList photos={photos} onVisibilityChange={noop} />);
    expect(screen.getByTestId("photo-path")).toHaveTextContent("vacation/beach.jpg");
  });

  it("renders a thumbnail img when thumbnail data is present", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "a.jpg", thumbnail: "abc123" },
    ];
    render(<PhotoList photos={photos} onVisibilityChange={noop} />);
    const img = document.querySelector(".photo-thumb-img") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "data:image/jpeg;base64,abc123");
  });

  it("renders a placeholder when thumbnail is null", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "a.jpg", thumbnail: null },
    ];
    render(<PhotoList photos={photos} onVisibilityChange={noop} />);
    expect(document.querySelector(".photo-thumb-placeholder")).toBeInTheDocument();
  });

  it("sets data-path attribute on each row for IntersectionObserver", () => {
    const photos: PhotoInfo[] = [
      { relative_path: "vacation/beach.jpg", thumbnail: null },
      { relative_path: "portrait.png", thumbnail: null },
    ];
    render(<PhotoList photos={photos} onVisibilityChange={noop} />);
    const rows = screen.getAllByTestId("photo-row");
    expect(rows[0]).toHaveAttribute("data-path", "vacation/beach.jpg");
    expect(rows[1]).toHaveAttribute("data-path", "portrait.png");
  });

  it("calls onVisibilityChange when IntersectionObserver fires", () => {
    // jsdom doesn't implement IntersectionObserver, so we stub it.
    const observed: Element[] = [];
    const callbacks: IntersectionObserverCallback[] = [];

    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback) { callbacks.push(cb); }
      observe(el: Element) { observed.push(el); }
      disconnect() {}
    });

    const handler = vi.fn();
    const photos: PhotoInfo[] = [
      { relative_path: "a.jpg", thumbnail: null },
      { relative_path: "b.jpg", thumbnail: null },
    ];
    render(<PhotoList photos={photos} onVisibilityChange={handler} />);

    // Simulate both rows becoming visible.
    const entries = observed.map((el) => ({
      target: el,
      isIntersecting: true,
    })) as IntersectionObserverEntry[];

    callbacks[0](entries, {} as IntersectionObserver);

    expect(handler).toHaveBeenCalledWith(
      expect.arrayContaining(["a.jpg", "b.jpg"])
    );

    vi.unstubAllGlobals();
  });
});

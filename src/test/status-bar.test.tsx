import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { StatusBar } from "../components/StatusBar";
import { MetadataProgressStore } from "../types";

const noop = () => {};
const base = {
  fileCount: 42,
  scanning: false,
  metadataProgress: null,
  selectedCount: 0,
};

describe("StatusBar", () => {
  beforeEach(() => cleanup());

  it("shows total file count with no selection or filters", () => {
    render(<StatusBar {...base} />);
    expect(screen.getByTestId("status-bar-count")).toHaveTextContent(
      "42 files",
    );
    expect(
      screen.queryByTestId("status-bar-selection"),
    ).not.toBeInTheDocument();
  });

  it("uses singular 'file' when total is exactly 1", () => {
    render(<StatusBar {...base} fileCount={1} />);
    expect(screen.getByTestId("status-bar-count")).toHaveTextContent("1 file");
  });

  it("shows 'N of M files' when filtered", () => {
    render(<StatusBar {...base} fileCount={3} fileCountTotal={42} />);
    expect(screen.getByTestId("status-bar-count")).toHaveTextContent(
      "3 of 42 files",
    );
  });

  it("shows selection count separately (no duplicate total)", () => {
    render(<StatusBar {...base} selectedCount={3} />);
    expect(screen.getByTestId("status-bar-selection")).toHaveTextContent(
      "3 selected",
    );
    expect(screen.getByTestId("status-bar-count")).toHaveTextContent(
      "42 files",
    );
  });

  it("hides selection chunk when nothing selected", () => {
    render(<StatusBar {...base} selectedCount={0} />);
    expect(
      screen.queryByTestId("status-bar-selection"),
    ).not.toBeInTheDocument();
  });

  it("shows scanning indicator while scanning", () => {
    render(<StatusBar {...base} scanning={true} />);
    expect(screen.getByTestId("status-bar-scanning")).toHaveTextContent(
      "Discovering files…",
    );
  });

  it("shows metadata loading indicator when metadata progress > 0", () => {
    const progress = new MetadataProgressStore();
    progress.setTotal(10);
    progress.incrementReceived(5);
    render(<StatusBar {...base} metadataProgress={progress} />);
    expect(
      screen.getByTestId("status-bar-metadata-spinner"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("status-bar-metadata-label")).toHaveTextContent(
      "Loading metadata… (5 of 10)",
    );
  });

  it("hides metadata indicator while scanning (scan spinner takes precedence)", () => {
    const progress = new MetadataProgressStore();
    progress.setTotal(10);
    progress.incrementReceived(5);
    render(<StatusBar {...base} scanning={true} metadataProgress={progress} />);
    expect(screen.queryByTestId("status-bar-metadata")).not.toBeInTheDocument();
  });

  it("renders draft summary and Apply/Discard buttons when there are drafts", () => {
    render(
      <StatusBar
        {...base}
        draftEditsSummary={{ files: 2, edits: 5 }}
        onApplyAllEdits={noop}
        onDiscardAllEdits={noop}
      />,
    );
    expect(screen.getByTestId("status-bar-draft-summary")).toHaveTextContent(
      "5 draft edits across 2 files",
    );
    expect(screen.getByTestId("status-bar-apply-all-btn")).toBeInTheDocument();
    expect(
      screen.getByTestId("status-bar-discard-all-btn"),
    ).toBeInTheDocument();
  });

  it("invokes onClickDraftSummary when summary is clicked", async () => {
    const handler = vi.fn();
    render(
      <StatusBar
        {...base}
        draftEditsSummary={{ files: 1, edits: 1 }}
        onClickDraftSummary={handler}
      />,
    );
    await userEvent.click(screen.getByTestId("status-bar-draft-summary"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("hides draft area when there are no drafts", () => {
    render(<StatusBar {...base} draftEditsSummary={null} />);
    expect(
      screen.queryByTestId("status-bar-draft-summary"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("status-bar-apply-all-btn"),
    ).not.toBeInTheDocument();
  });
});

import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { SelectionFooter } from "../components/SelectionFooter";

describe("SelectionFooter", () => {
  beforeEach(() => cleanup());

  it("shows total photo count when nothing is selected", () => {
    render(<SelectionFooter selectedCount={0} totalCount={42} />);
    expect(screen.getByTestId("selection-footer")).toHaveTextContent("42 photos");
  });

  it("uses singular 'photo' when total is exactly 1", () => {
    render(<SelectionFooter selectedCount={0} totalCount={1} />);
    expect(screen.getByTestId("selection-footer")).toHaveTextContent("1 photo");
  });

  it("shows 'N of M selected' when one or more rows are selected", () => {
    render(<SelectionFooter selectedCount={3} totalCount={42} />);
    expect(screen.getByTestId("selection-footer")).toHaveTextContent("3 of 42 selected");
  });

  it("handles a single selection too", () => {
    render(<SelectionFooter selectedCount={1} totalCount={42} />);
    expect(screen.getByTestId("selection-footer")).toHaveTextContent("1 of 42 selected");
  });
});

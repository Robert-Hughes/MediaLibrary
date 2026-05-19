import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { BatchSummaryCountersRow } from "../components/BatchSummaryCountersRow";

describe("BatchSummaryCountersRow", () => {
  it("renders label/value pairs joined by ' · '", () => {
    const { container } = render(
      <BatchSummaryCountersRow
        counters={[
          { label: "Hits", value: 3 },
          { label: "Misses", value: 4 },
        ]}
      />,
    );
    expect(container.textContent).toBe("Hits: 3 · Misses: 4");
  });

  it("hides counters with show=false", () => {
    const { container } = render(
      <BatchSummaryCountersRow
        counters={[
          { label: "A", value: 1 },
          { label: "B", value: 2, show: false },
          { label: "C", value: 3 },
        ]}
      />,
    );
    expect(container.textContent).toBe("A: 1 · C: 3");
  });

  it("does not emit a leading separator when only one counter is visible", () => {
    const { container } = render(
      <BatchSummaryCountersRow
        counters={[
          { label: "Hidden", value: 0, show: false },
          { label: "Visible", value: "ok" },
        ]}
      />,
    );
    expect(container.textContent).toBe("Visible: ok");
  });

  it("bolds the value with <strong>", () => {
    const { getByText } = render(
      <BatchSummaryCountersRow counters={[{ label: "X", value: 42 }]} />,
    );
    expect(getByText("42").tagName).toBe("STRONG");
  });

  it("forwards data-testid", () => {
    const { getByTestId } = render(
      <BatchSummaryCountersRow
        data-testid="my-row"
        counters={[{ label: "A", value: 1 }]}
      />,
    );
    expect(getByTestId("my-row")).toBeTruthy();
  });

  it("returns no counters when all are hidden", () => {
    const { container } = render(
      <BatchSummaryCountersRow
        counters={[
          { label: "A", value: 1, show: false },
          { label: "B", value: 2, show: false },
        ]}
      />,
    );
    expect(container.textContent).toBe("");
  });
});

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VerifyOutcomeDialog } from "../components/VerifyOutcomeDialog";
import type { TagOutcomeEntry } from "../types";

describe("VerifyOutcomeDialog", () => {
  it("shows friendly and diagnostic metadata values", () => {
    const outcomes: Record<string, TagOutcomeEntry[]> = {
      "a.jpg": [
        {
          tag: "XMP-dc:Rights",
          kind: "Mismatch",
          sent: { kind: "Text", value: "Copyright 2008" },
          before: null,
          observed: {
            kind: "LangAlt",
            value: { "x-default": "Copyright 2008" },
          },
          message: null,
        },
        {
          tag: "IPTC:TimeCreated",
          kind: "Mismatch",
          sent: {
            kind: "Time",
            value: {
              hour: 8,
              minute: 6,
              second: 49,
              subsecond: null,
              offset: null,
            },
          },
          before: null,
          observed: {
            kind: "Time",
            value: {
              hour: 8,
              minute: 6,
              second: 49,
              subsecond: null,
              offset: { sign: "Plus", hours: 1, minutes: 0 },
            },
          },
          message: null,
        },
      ],
    };

    render(
      <VerifyOutcomeDialog
        outcomes={outcomes}
        onAccept={vi.fn()}
        onRevert={vi.fn()}
        onDismiss={vi.fn()}
        onDismissAll={vi.fn()}
      />,
    );

    const rightsRow = screen.getByTestId(
      "verify-outcome-row-a.jpg-XMP-dc:Rights",
    );
    expect(within(rightsRow).getAllByText("Copyright 2008")).toHaveLength(2);
    expect(within(rightsRow).getByText('Text("Copyright 2008")')).toBeTruthy();
    expect(
      within(rightsRow).getByText('LangAlt{x-default: "Copyright 2008"}'),
    ).toBeTruthy();

    const timeRow = screen.getByTestId(
      "verify-outcome-row-a.jpg-IPTC:TimeCreated",
    );
    expect(within(timeRow).getAllByText("08:06:49")).toHaveLength(1);
    expect(within(timeRow).getAllByText("08:06:49+01:00")).toHaveLength(1);
    expect(within(timeRow).getByText("Time(08:06:49)")).toBeTruthy();
    expect(within(timeRow).getByText("Time(08:06:49+01:00)")).toBeTruthy();
  });
});

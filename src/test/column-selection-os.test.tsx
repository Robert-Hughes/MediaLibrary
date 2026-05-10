import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";
import type { VisibleColumn } from "../types";

describe("ColumnSelectionDialog OS Metadata", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
  ];

  const cols = (...arr: VisibleColumn[]): VisibleColumn[] => arr;

  it("renders OS metadata section with checkboxes", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
        )}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    expect(screen.getByText("OS Metadata")).toBeInTheDocument();
    expect(screen.getByText("Date Modified")).toBeInTheDocument();
    expect(screen.getByText("Date Created")).toBeInTheDocument();
    expect(screen.getByText("Image Metadata")).toBeInTheDocument();
  });

  it("shows OS columns as checked when they are visible", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
        )}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.find(c => c.nextSibling?.textContent === "Date Modified")?.checked).toBe(true);
    expect(checkboxes.find(c => c.nextSibling?.textContent === "Date Created")?.checked).toBe(true);
  });

  it("shows OS columns as unchecked when they are not visible", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.find(c => c.nextSibling?.textContent === "Date Modified")?.checked).toBe(false);
    expect(checkboxes.find(c => c.nextSibling?.textContent === "Date Created")?.checked).toBe(false);
  });

  it("calls onSave with updated OS column selection", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "date_modified", kind: "os" },
          { key: "IFD0:Model", kind: "image" },
        )}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    await userEvent.click(screen.getByText("Date Created"));
    await userEvent.click(screen.getByText("Save Changes"));

    const [saved] = onSave.mock.calls[0];
    const keys = (saved as VisibleColumn[]).map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["date_modified", "date_created", "IFD0:Model"]));
  });

  it("calls onSave with updated OS column deselection", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "IFD0:Model", kind: "image" },
        )}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    await userEvent.click(screen.getByText("Date Modified"));
    await userEvent.click(screen.getByText("Save Changes"));

    expect(onSave).toHaveBeenCalledWith(
      [
        { key: "date_created", kind: "os" },
        { key: "IFD0:Model", kind: "image" },
      ],
      false,
    );
  });
});

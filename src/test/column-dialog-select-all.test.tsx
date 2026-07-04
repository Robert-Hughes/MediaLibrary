import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";
import { DEFAULT_VISIBLE_COLUMNS } from "../utils/columnConfig";
import type { VisibleColumn } from "../types";

describe("ColumnSelectionDialog Select All / Deselect All", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
    { key: "XMP-dc:Subject", count: 5 },
  ];

  const cols = (...arr: VisibleColumn[]): VisibleColumn[] => arr;

  it("renders Select All and Deselect All buttons", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Select All")).toBeInTheDocument();
    expect(screen.getByText("Deselect All")).toBeInTheDocument();
  });

  it("selects all columns when Select All is clicked", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("Select All"));

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    checkboxes.forEach((cb) => expect(cb.checked).toBe(true));

    await userEvent.click(screen.getByText("Save Changes"));
    const [saved] = onSave.mock.calls[0];
    const keys = saved.map((c: VisibleColumn) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "IFD0:Model",
        "IFD0:Make",
        "XMP-dc:Subject",
        "date_modified",
        "date_created",
      ]),
    );
  });

  it("deselects all columns when Deselect All is clicked", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "date_modified", kind: "os" },
          { key: "date_created", kind: "os" },
          { key: "IFD0:Model", kind: "image" },
          { key: "IFD0:Make", kind: "image" },
        )}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("Deselect All"));

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    checkboxes.forEach((cb) => expect(cb.checked).toBe(false));

    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith([], false);
  });

  it("Select All works after making individual selections", async () => {
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
      />,
    );

    await userEvent.click(screen.getByText("IFD0:Make"));
    await userEvent.click(screen.getByText("Date Created"));

    await userEvent.click(screen.getByText("Select All"));
    await userEvent.click(screen.getByText("Save Changes"));

    const [saved] = onSave.mock.calls[0];
    const keys = saved.map((c: VisibleColumn) => c.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "IFD0:Model",
        "IFD0:Make",
        "XMP-dc:Subject",
        "date_modified",
        "date_created",
      ]),
    );
  });

  it("Deselect All works after Select All", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("Select All"));
    await userEvent.click(screen.getByText("Deselect All"));

    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith([], false);
  });

  it("renders Default button", () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("Default button resets selection to defaults, with resetWidths=true", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "IFD0:Model", kind: "image" },
          { key: "IFD0:Make", kind: "image" },
        )}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("Default"));
    await userEvent.click(screen.getByText("Save Changes"));

    const [saved, resetWidths] = onSave.mock.calls[0];
    expect(resetWidths).toBe(true);
    const savedKeys = (saved as VisibleColumn[]).map((c) => c.key).sort();
    const defaultKeys = DEFAULT_VISIBLE_COLUMNS.map((c) => c.key).sort();
    expect(savedKeys).toEqual(defaultKeys);
  });

  it("normal Save does not set resetWidths", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols({ key: "IFD0:Model", kind: "image" })}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("Save Changes"));

    expect(onSave).toHaveBeenCalledWith(
      [{ key: "IFD0:Model", kind: "image" }],
      false,
    );
  });

  it("Default button produces columns matching DEFAULT_VISIBLE_COLUMNS order", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog
        allKeys={[...allKeys, { key: "ExifIFD:DateTimeOriginal", count: 3 }]}
        visibleColumns={cols({ key: "IFD0:Model", kind: "image" })}
        onSave={onSave}
        onClose={() => {}}
      />,
    );

    await userEvent.click(screen.getByText("Default"));
    await userEvent.click(screen.getByText("Save Changes"));

    const [saved] = onSave.mock.calls[0];
    const keys = (saved as VisibleColumn[]).map((c) => c.key);
    // ExifIFD:DateTimeOriginal precedes XMP-dc:Subject in defaults
    expect(keys.indexOf("ExifIFD:DateTimeOriginal")).toBeLessThan(
      keys.indexOf("XMP-dc:Subject"),
    );
  });
});

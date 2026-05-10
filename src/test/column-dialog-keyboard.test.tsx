import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";
import type { VisibleColumn } from "../types";

describe("ColumnSelectionDialog keyboard shortcuts", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
  ];

  const cols = (...arr: VisibleColumn[]): VisibleColumn[] => arr;

  it("closes dialog when Escape key is pressed", async () => {
    const onClose = vi.fn();
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
        onClose={onClose}
      />
    );

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves changes when Enter key is pressed", async () => {
    const onClose = vi.fn();
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
        onClose={onClose}
      />
    );

    await userEvent.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith(
      [
        { key: "date_modified", kind: "os" },
        { key: "date_created", kind: "os" },
        { key: "IFD0:Model", kind: "image" },
      ],
      false,
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves current selection state when Enter is pressed after making changes", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={cols(
          { key: "date_modified", kind: "os" },
          { key: "IFD0:Model", kind: "image" },
        )}
        onSave={onSave}
        onClose={onClose}
      />
    );

    await userEvent.click(screen.getByText("IFD0:Make"));
    await userEvent.click(screen.getByText("Date Created"));

    await userEvent.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledTimes(1);
    const [savedCols, resetWidths] = onSave.mock.calls[0];
    expect(resetWidths).toBe(false);
    expect(savedCols).toEqual(expect.arrayContaining([
      { key: "date_modified", kind: "os" },
      { key: "date_created", kind: "os" },
      { key: "IFD0:Model", kind: "image" },
      { key: "IFD0:Make", kind: "image" },
    ]));
  });

  it("keyboard shortcuts work when dialog has focus", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        onSave={onSave}
        onClose={onClose}
      />
    );

    const dialog = screen.getByTestId("column-dialog");
    dialog.focus();

    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

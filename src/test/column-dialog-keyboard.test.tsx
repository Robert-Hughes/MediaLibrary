import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";

describe("ColumnSelectionDialog keyboard shortcuts", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
  ];

  it("closes dialog when Escape key is pressed", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={["IFD0:Model"]} 
        visibleOSColumns={["date_modified", "date_created"]} 
        onSave={onSave} 
        onClose={onClose} 
      />
    );

    // Press Escape key
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
        visibleColumns={["IFD0:Model"]} 
        visibleOSColumns={["date_modified", "date_created"]} 
        onSave={onSave} 
        onClose={onClose} 
      />
    );

    // Press Enter key
    await userEvent.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith(
      ["IFD0:Model"],
      ["date_modified", "date_created"]
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it("saves current selection state when Enter is pressed after making changes", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={["IFD0:Model"]} 
        visibleOSColumns={["date_modified"]} 
        onSave={onSave} 
        onClose={onClose} 
      />
    );

    // Toggle IFD0:Make on
    const makeLabel = screen.getByText("IFD0:Make");
    await userEvent.click(makeLabel);

    // Toggle Date Created on
    const createdLabel = screen.getByText("Date Created");
    await userEvent.click(createdLabel);

    // Press Enter key
    await userEvent.keyboard("{Enter}");

    expect(onSave).toHaveBeenCalledWith(
      expect.arrayContaining(["IFD0:Model", "IFD0:Make"]),
      expect.arrayContaining(["date_modified", "date_created"])
    );
  });

  it("keyboard shortcuts work when dialog has focus", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]} 
        visibleOSColumns={[]} 
        onSave={onSave} 
        onClose={onClose} 
      />
    );

    // Focus on the dialog
    const dialog = screen.getByTestId("column-dialog");
    dialog.focus();

    // Press Escape
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
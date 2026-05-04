import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";

describe("ColumnSelectionDialog Select All / Deselect All", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
    { key: "XMP-dc:Subject", count: 5 },
  ];

  it("renders Select All and Deselect All buttons", () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]} 
        visibleOSColumns={[]} 
        onSave={() => {}} 
        onClose={() => {}} 
      />
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
        visibleOSColumns={[]} 
        onSave={onSave} 
        onClose={() => {}} 
      />
    );

    // Click Select All
    const selectAllButton = screen.getByText("Select All");
    await userEvent.click(selectAllButton);

    // All checkboxes should be checked
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    checkboxes.forEach(checkbox => {
      expect(checkbox.checked).toBe(true);
    });

    // Save and verify all columns are selected
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith(
      expect.arrayContaining(["IFD0:Model", "IFD0:Make", "XMP-dc:Subject"]),
      expect.arrayContaining(["date_modified", "date_created"])
    );
  });

  it("deselects all columns when Deselect All is clicked", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={["IFD0:Model", "IFD0:Make"]} 
        visibleOSColumns={["date_modified", "date_created"]} 
        onSave={onSave} 
        onClose={() => {}} 
      />
    );

    // Click Deselect All
    const deselectAllButton = screen.getByText("Deselect All");
    await userEvent.click(deselectAllButton);

    // All checkboxes should be unchecked
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    checkboxes.forEach(checkbox => {
      expect(checkbox.checked).toBe(false);
    });

    // Save and verify no columns are selected
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith([], []);
  });

  it("Select All works after making individual selections", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={["IFD0:Model"]} 
        visibleOSColumns={["date_modified"]} 
        onSave={onSave} 
        onClose={() => {}} 
      />
    );

    // Manually toggle some items
    const makeLabel = screen.getByText("IFD0:Make");
    await userEvent.click(makeLabel);

    const createdLabel = screen.getByText("Date Created");
    await userEvent.click(createdLabel);

    // Now click Select All - should select everything
    const selectAllButton = screen.getByText("Select All");
    await userEvent.click(selectAllButton);

    // Save and verify all columns are selected
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith(
      expect.arrayContaining(["IFD0:Model", "IFD0:Make", "XMP-dc:Subject"]),
      expect.arrayContaining(["date_modified", "date_created"])
    );
  });

  it("Deselect All works after Select All", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]} 
        visibleOSColumns={[]} 
        onSave={onSave} 
        onClose={() => {}} 
      />
    );

    // First select all
    const selectAllButton = screen.getByText("Select All");
    await userEvent.click(selectAllButton);

    // Then deselect all
    const deselectAllButton = screen.getByText("Deselect All");
    await userEvent.click(deselectAllButton);

    // Save and verify no columns are selected
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith([], []);
  });
});
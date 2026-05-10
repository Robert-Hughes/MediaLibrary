import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";

describe("ColumnSelectionDialog OS Metadata", () => {
  const allKeys = [
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
  ];

  it("renders OS metadata section with checkboxes", () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]} 
        visibleOSColumns={["date_modified", "date_created"]} 
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
        visibleColumns={[]} 
        visibleOSColumns={["date_modified", "date_created"]} 
        onSave={() => {}} 
        onClose={() => {}} 
      />
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const modifiedCheckbox = checkboxes.find(c => c.nextSibling?.textContent === "Date Modified");
    const createdCheckbox = checkboxes.find(c => c.nextSibling?.textContent === "Date Created");
    
    expect(modifiedCheckbox?.checked).toBe(true);
    expect(createdCheckbox?.checked).toBe(true);
  });

  it("shows OS columns as unchecked when they are not visible", () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]} 
        visibleOSColumns={[]} 
        onSave={() => {}} 
        onClose={() => {}} 
      />
    );

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    const modifiedCheckbox = checkboxes.find(c => c.nextSibling?.textContent === "Date Modified");
    const createdCheckbox = checkboxes.find(c => c.nextSibling?.textContent === "Date Created");
    
    expect(modifiedCheckbox?.checked).toBe(false);
    expect(createdCheckbox?.checked).toBe(false);
  });

  it("calls onSave with updated OS column selection", async () => {
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

    // Toggle Date Created on
    const createdLabel = screen.getByText("Date Created");
    await userEvent.click(createdLabel);
    
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith(
      ["IFD0:Model"],
      expect.arrayContaining(["date_modified", "date_created"]),
      false
    );
  });

  it("calls onSave with updated OS column deselection", async () => {
    const onSave = vi.fn();
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={["IFD0:Model"]} 
        visibleOSColumns={["date_modified", "date_created"]} 
        onSave={onSave} 
        onClose={() => {}} 
      />
    );

    // Toggle Date Modified off
    const modifiedLabel = screen.getByText("Date Modified");
    await userEvent.click(modifiedLabel);
    
    await userEvent.click(screen.getByText("Save Changes"));
    expect(onSave).toHaveBeenCalledWith(
      ["IFD0:Model"],
      ["date_created"],
      false
    );
  });
});
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { vi } from "vitest";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";

describe("ColumnSelectionDialog search functionality", () => {
  const allKeys = [
    { key: "EXIF:DateTimeOriginal", count: 15 },
    { key: "IFD0:Model", count: 10 },
    { key: "IFD0:Make", count: 8 },
    { key: "XMP-dc:Subject", count: 5 },
    { key: "GPS:GPSLatitude", count: 3 },
    { key: "GPS:GPSLongitude", count: 3 },
    { key: "XMP-photoshop:City", count: 7 },
  ];

  it("renders search input", () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    expect(searchInput).toBeInTheDocument();
  });

  it("filters columns based on search term", async () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    
    // Search for "GPS" - should show only GPS columns
    await userEvent.type(searchInput, "GPS");

    expect(screen.getByText("GPS:GPSLatitude")).toBeInTheDocument();
    expect(screen.getByText("GPS:GPSLongitude")).toBeInTheDocument();
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
    expect(screen.queryByText("EXIF:DateTimeOriginal")).not.toBeInTheDocument();
  });

  it("search is case insensitive", async () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    
    // Search for "xmp" in lowercase - should match XMP columns
    await userEvent.type(searchInput, "xmp");

    expect(screen.getByText("XMP-dc:Subject")).toBeInTheDocument();
    expect(screen.getByText("XMP-photoshop:City")).toBeInTheDocument();
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
    expect(screen.queryByText("GPS:GPSLatitude")).not.toBeInTheDocument();
  });

  it("shows no results message when no columns match", async () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    
    // Search for something that doesn't exist
    await userEvent.type(searchInput, "nonexistent");

    expect(screen.getByText("No columns match your search.")).toBeInTheDocument();
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
  });

  it("clears search and shows all columns when search is cleared", async () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    
    // First search for something specific
    await userEvent.type(searchInput, "GPS");
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();

    // Clear the search
    await userEvent.clear(searchInput);

    // All columns should be visible again
    expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
    expect(screen.getByText("EXIF:DateTimeOriginal")).toBeInTheDocument();
    expect(screen.getByText("GPS:GPSLatitude")).toBeInTheDocument();
  });

  it("can select filtered columns and save", async () => {
    const onSave = vi.fn();

    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={onSave}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    
    // Search for GPS columns
    await userEvent.type(searchInput, "GPS");

    // Select GPS:GPSLatitude
    const latitudeLabel = screen.getByText("GPS:GPSLatitude");
    await userEvent.click(latitudeLabel);

    // Save changes
    await userEvent.click(screen.getByText("Save Changes"));

    expect(onSave).toHaveBeenCalledWith(
      [{ key: "GPS:GPSLatitude", kind: "image" }],
      false,
    );
  });

  it("search works with partial matches", async () => {
    render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    
    // Search for "Date" - should match DateTimeOriginal
    await userEvent.type(searchInput, "Date");

    expect(screen.getByText("EXIF:DateTimeOriginal")).toBeInTheDocument();
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
  });
});
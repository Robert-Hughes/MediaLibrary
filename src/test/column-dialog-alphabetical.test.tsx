import { render, screen } from "@testing-library/react";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";

describe("ColumnSelectionDialog alphabetical sorting", () => {
  it("shows image metadata fields in alphabetical order", () => {
    const allKeys = [
      { key: "XMP-dc:Subject", count: 5 },
      { key: "IFD0:Model", count: 10 }, // Higher count but should come after A-M
      { key: "EXIF:DateTimeOriginal", count: 15 }, // Highest count but should come first alphabetically
      { key: "GPS:GPSLatitude", count: 3 },
      { key: "IFD0:Make", count: 8 },
    ];

    const { container } = render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    // Check that each field appears in the document
    expect(screen.getByText("EXIF:DateTimeOriginal")).toBeInTheDocument();
    expect(screen.getByText("GPS:GPSLatitude")).toBeInTheDocument();
    expect(screen.getByText("IFD0:Make")).toBeInTheDocument();
    expect(screen.getByText("IFD0:Model")).toBeInTheDocument();
    expect(screen.getByText("XMP-dc:Subject")).toBeInTheDocument();

    // Get all column items and check their order
    const columnItems = container.querySelectorAll(".column-item");
    const imageMetadataItems = Array.from(columnItems).slice(2); // Skip the first 2 OS metadata items
    const labelTexts = imageMetadataItems.map(item => 
      item.querySelector('.column-label')?.textContent
    );

    // Should be in alphabetical order
    const expectedOrder = [
      "EXIF:DateTimeOriginal",
      "GPS:GPSLatitude", 
      "IFD0:Make",
      "IFD0:Model",
      "XMP-dc:Subject"
    ];

    expect(labelTexts).toEqual(expectedOrder);
  });

  it("maintains alphabetical order regardless of count values", () => {
    const allKeys = [
      { key: "Z-Last:Field", count: 1000 }, // Very high count but should be last
      { key: "A-First:Field", count: 1 }, // Very low count but should be first
      { key: "M-Middle:Field", count: 500 },
    ];

    const { container } = render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    // Get all the field labels in order they appear
    const columnItems = container.querySelectorAll(".column-item");
    const imageMetadataItems = Array.from(columnItems).slice(2); // Skip OS metadata items
    const labelTexts = imageMetadataItems.map(item => 
      item.querySelector('.column-label')?.textContent
    );

    // Should be in alphabetical order, not by count
    expect(labelTexts).toEqual([
      "A-First:Field",
      "M-Middle:Field", 
      "Z-Last:Field"
    ]);
  });

  it("case-insensitive alphabetical sorting", () => {
    const allKeys = [
      { key: "xmp-dc:Subject", count: 5 },
      { key: "IFD0:Model", count: 10 },
      { key: "EXIF:DateTimeOriginal", count: 15 },
      { key: "gps:GPSLatitude", count: 3 },
    ];

    const { container } = render(
      <ColumnSelectionDialog 
        allKeys={allKeys} 
        visibleColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const columnItems = container.querySelectorAll(".column-item");
    const imageMetadataItems = Array.from(columnItems).slice(2); // Skip OS metadata items
    const labelTexts = imageMetadataItems.map(item => 
      item.querySelector('.column-label')?.textContent
    );

    // Should be sorted case-insensitively
    expect(labelTexts).toEqual([
      "EXIF:DateTimeOriginal",
      "gps:GPSLatitude",
      "IFD0:Model", 
      "xmp-dc:Subject"
    ]);
  });
});
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { ColumnSelectionDialog } from "../components/ColumnSelectionDialog";

describe("ColumnSelectionDialog search filters OS metadata fields", () => {
  const allKeys = [
    { key: "EXIF:DateTimeOriginal", count: 15 },
    { key: "IFD0:Model", count: 10 },
  ];

  it("shows OS metadata fields when search term matches 'Date Modified'", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "date modified");

    expect(screen.getByText("Date Modified")).toBeInTheDocument();
    expect(screen.queryByText("Date Created")).not.toBeInTheDocument();
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
  });

  it("shows OS metadata fields when search term matches 'date_created' key", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "created");

    expect(screen.getByText("Date Created")).toBeInTheDocument();
    expect(screen.queryByText("Date Modified")).not.toBeInTheDocument();
    expect(screen.queryByText("IFD0:Model")).not.toBeInTheDocument();
  });

  it("shows both OS fields when search term matches both (e.g. 'date')", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "date");

    expect(screen.getByText("Date Modified")).toBeInTheDocument();
    expect(screen.getByText("Date Created")).toBeInTheDocument();
  });

  it("hides OS Metadata section entirely when search matches only image metadata", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "EXIF");

    expect(screen.getByText("EXIF:DateTimeOriginal")).toBeInTheDocument();
    expect(screen.queryByText("Date Modified")).not.toBeInTheDocument();
    expect(screen.queryByText("Date Created")).not.toBeInTheDocument();
    // Section header should also be gone
    expect(screen.queryByText("OS Metadata")).not.toBeInTheDocument();
  });

  it("shows 'no results' message when search matches neither OS nor image metadata", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "zzznomatch");

    expect(screen.getByText("No columns match your search.")).toBeInTheDocument();
    expect(screen.queryByText("Date Modified")).not.toBeInTheDocument();
    expect(screen.queryByText("OS Metadata")).not.toBeInTheDocument();
  });

  it("does not show 'no results' when only OS fields match", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "modified");

    expect(screen.queryByText("No columns match your search.")).not.toBeInTheDocument();
    expect(screen.getByText("Date Modified")).toBeInTheDocument();
  });

  it("search is case-insensitive for OS fields", async () => {
    render(
      <ColumnSelectionDialog
        allKeys={allKeys}
        visibleColumns={[]}
        visibleOSColumns={[]}
        onSave={() => {}}
        onClose={() => {}}
      />
    );

    const searchInput = screen.getByPlaceholderText("Search columns...");
    await userEvent.type(searchInput, "DATE MODIFIED");

    expect(screen.getByText("Date Modified")).toBeInTheDocument();
  });
});

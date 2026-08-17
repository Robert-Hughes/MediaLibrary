import { describe, expect, it, vi } from "vitest";
import { fileManagerName, isMacOS, recycleBinName } from "../utils/platform";

describe("platform", () => {
  it("recognises macOS without treating Windows as macOS", () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    platform.mockReturnValue("MacIntel");
    expect(isMacOS()).toBe(true);
    expect(fileManagerName()).toBe("Finder");
    expect(recycleBinName()).toBe("Trash");
    platform.mockReturnValue("Win32");
    expect(isMacOS()).toBe(false);
    expect(fileManagerName()).toBe("File Explorer");
    expect(recycleBinName()).toBe("Recycle Bin");
    platform.mockRestore();
  });
});

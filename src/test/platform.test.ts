import { describe, expect, it, vi } from "vitest";
import { isMacOS } from "../utils/platform";

describe("platform", () => {
  it("recognises macOS without treating Windows as macOS", () => {
    const platform = vi.spyOn(navigator, "platform", "get");
    platform.mockReturnValue("MacIntel");
    expect(isMacOS()).toBe(true);
    platform.mockReturnValue("Win32");
    expect(isMacOS()).toBe(false);
    platform.mockRestore();
  });
});

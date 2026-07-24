import { describe, expect, it, vi } from "vitest";
import { frontendNow, logSlowFrontendOperation } from "../frontendPerformance";

describe("frontend performance logging", () => {
  it("logs slow operations with consistent fields and millisecond precision", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const startedAt = frontendNow() - 75.25;

    expect(
      logSlowFrontendOperation(
        "draft-store-batch",
        startedAt,
        { files: 20, changed: true },
        50,
      ),
    ).toBe(true);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toMatch(
      /^\[perf\] operation=draft-store-batch duration_ms=\d+\.\d files=20 changed=true$/,
    );
    info.mockRestore();
  });

  it("does not log work below the threshold", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(
      logSlowFrontendOperation("fast-operation", frontendNow(), {}, 50),
    ).toBe(false);
    expect(info).not.toHaveBeenCalled();
    info.mockRestore();
  });
});

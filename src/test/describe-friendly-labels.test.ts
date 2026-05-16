/**
 * Unit tests for the failure-kind → friendly-label mapping shown in
 * `DescribeProgressDialog`. Kept out of the React DOM tests because the
 * mapping is a pure function and we want to spot-check several kinds at
 * once without spinning up the full describe-flow harness.
 */
import { describe, it, expect } from "vitest";
import { friendlyFailureLabel } from "../components/DescribeProgressDialog";

describe("friendlyFailureLabel", () => {
  it("maps known backend kinds to short human-readable labels", () => {
    expect(friendlyFailureLabel("decode")).toBe("Could not decode image");
    expect(friendlyFailureLabel("http")).toBe("API request failed");
    expect(friendlyFailureLabel("network")).toBe("Network error");
    expect(friendlyFailureLabel("incomplete")).toBe("Response was truncated");
    expect(friendlyFailureLabel("refused")).toBe("Refused by model");
    expect(friendlyFailureLabel("bad_json")).toBe("Could not parse model response");
  });

  it("calls out the usage_parse case so users know the description landed", () => {
    // Regression: usage_parse is the one kind where the model returned
    // a usable description but cost reporting failed — the label must
    // not look like a hard failure.
    expect(friendlyFailureLabel("usage_parse"))
      .toMatch(/Description received but token usage could not be measured/);
  });

  it("falls through to the raw kind for unknown values", () => {
    // Forward-compat: a new backend status string should still be visible
    // rather than vanishing or rendering as "undefined".
    expect(friendlyFailureLabel("some_new_kind")).toBe("some_new_kind");
  });
});

/**
 * Unit tests for the failure-kind → friendly-label mapping shown in
 * `DescribeProgressDialog`. Kept out of the React DOM tests because the
 * mapping is a pure function and we want to spot-check several kinds at
 * once without spinning up the full describe-flow harness.
 */
import { describe, it, expect } from "vitest";
import { friendlyDescribeFailureLabel } from "../components/batchHelpers";

describe("friendlyDescribeFailureLabel", () => {
  it("maps known backend kinds to short human-readable labels", () => {
    expect(friendlyDescribeFailureLabel("decode")).toBe(
      "Could not decode image",
    );
    expect(friendlyDescribeFailureLabel("http")).toBe("API request failed");
    expect(friendlyDescribeFailureLabel("network")).toBe("Network error");
    expect(friendlyDescribeFailureLabel("incomplete")).toBe(
      "Response was truncated",
    );
    expect(friendlyDescribeFailureLabel("refused")).toBe("Refused by model");
    expect(friendlyDescribeFailureLabel("bad_json")).toBe(
      "Could not parse model response",
    );
  });

  it("calls out the usage_parse case so users know the description landed", () => {
    // Regression: usage_parse is the one kind where the model returned
    // a usable description but cost reporting failed — the label must
    // not look like a hard failure.
    expect(friendlyDescribeFailureLabel("usage_parse")).toMatch(
      /Description received but token usage could not be measured/,
    );
  });

  // Exhaustiveness is now enforced by the TypeScript `BatchFailureKind`
  // union: a missing case is a compile-time error. The previous
  // "unknown kind falls through to raw" test was retired with the
  // typed-kind refactor.
});

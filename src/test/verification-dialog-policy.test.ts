// @vitest-environment node
import { describe, expect, it } from "vitest";
import { verificationDialogToShow } from "../utils/verificationDialogPolicy";

describe("production verification dialog ordering", () => {
  it("shows target verification first and legacy only after it empties", () => {
    expect(verificationDialogToShow(2, 1)).toBe("target");
    expect(verificationDialogToShow(0, 1)).toBe("legacy");
    expect(verificationDialogToShow(0, 0)).toBeNull();
  });
});

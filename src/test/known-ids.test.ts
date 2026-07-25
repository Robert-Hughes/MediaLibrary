import { describe, expect, it } from "vitest";
import { KNOWN_METADATA_IDS as ID } from "../metadata/knownIds";

describe("known metadata identities", () => {
  it("preserves the canonical XMP Photoshop namespace", () => {
    for (const id of [
      ID.xmpHeadline,
      ID.xmpCity,
      ID.xmpState,
      ID.xmpCountry,
      ID.xmpDateCreated,
    ]) {
      expect(id.table).toBe("XMP::photoshop");
    }
  });
});

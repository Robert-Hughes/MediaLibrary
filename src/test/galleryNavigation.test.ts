import { describe, expect, it } from "vitest";
import { galleryPathAfterRemoval } from "../utils/galleryNavigation";
import { makeFiles } from "./factories";

describe("galleryPathAfterRemoval", () => {
  const matches = makeFiles(["first.jpg", "middle.jpg", "last.jpg"]);

  it("advances to the next matching file", () => {
    expect(galleryPathAfterRemoval(matches, 1)).toBe("last.jpg");
  });

  it("falls back to the previous match after deleting the last file", () => {
    expect(galleryPathAfterRemoval(matches, 2)).toBe("middle.jpg");
  });

  it("closes when no matching neighbour remains", () => {
    expect(galleryPathAfterRemoval(matches.slice(0, 1), 0)).toBeNull();
  });
});

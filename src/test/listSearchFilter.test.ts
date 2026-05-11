import { describe, it, expect } from "vitest";
import { ImageMetadataStore } from "../types";
import { makePhoto } from "./factories";
import {
  buildListSearchHaystack,
  filterPhotosForListSearch,
  photoMatchesListSearch,
} from "../utils/listSearchFilter";

describe("buildListSearchHaystack", () => {
  it("includes path and formatted dates", () => {
    const p = makePhoto({
      relative_path: "sub/x.jpg",
      date_modified: 1_700_000_000,
      date_created: null,
    });
    const h = buildListSearchHaystack(p, "loading");
    expect(h).toContain("sub/x.jpg");
    expect(h).toContain("x.jpg");
    expect(h).toContain("—");
  });

  it("includes all metadata keys and values", () => {
    const p = makePhoto({ relative_path: "a.jpg" });
    const meta = { "IFD0:Make": "Canon", "IFD0:Model": "R5" };
    const h = buildListSearchHaystack(p, meta);
    expect(h).toContain("IFD0:Make");
    expect(h).toContain("Canon");
    expect(h).toContain("R5");
  });
});

describe("filterPhotosForListSearch", () => {
  it("returns all photos when query is blank", () => {
    const store = new ImageMetadataStore();
    const photos = [makePhoto({ relative_path: "a.jpg" }), makePhoto({ relative_path: "b.jpg" })];
    photos.forEach((p) => store.add(p.relative_path));
    expect(filterPhotosForListSearch(photos, "   ", store)).toHaveLength(2);
  });

  it("filters by hidden metadata key", () => {
    const store = new ImageMetadataStore();
    const a = makePhoto({ relative_path: "a.jpg" });
    const b = makePhoto({ relative_path: "b.jpg" });
    store.add(a.relative_path);
    store.add(b.relative_path);
    store.set(a.relative_path, { "Secret:Tag": "hidden-value" });
    store.set(b.relative_path, { "Secret:Tag": "other" });

    const out = filterPhotosForListSearch([a, b], "hidden-value", store);
    expect(out.map((p) => p.relative_path)).toEqual(["a.jpg"]);
  });

  it("photoMatchesListSearch respects metadata", () => {
    const p = makePhoto({ relative_path: "z.jpg" });
    expect(photoMatchesListSearch(p, "nope", "loading")).toBe(false);
    expect(photoMatchesListSearch(p, "z.jpg", "loading")).toBe(true);
    expect(photoMatchesListSearch(p, "lens", { "Exif:LensModel": "50mm" })).toBe(true);
  });
});

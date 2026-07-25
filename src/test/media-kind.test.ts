import { describe, expect, it } from "vitest";
import { arePathsImageOnly } from "../utils/mediaKind";
import type { FileInfo } from "../types";

const files: FileInfo[] = [
  {
    relative_path: "image.jpg",
    filename: "image.jpg",
    media_kind: "image",
    date_modified: null,
    date_created: null,
  },
  {
    relative_path: "audio.flac",
    filename: "audio.flac",
    media_kind: "audio",
    date_modified: null,
    date_created: null,
  },
  {
    relative_path: "video.mp4",
    filename: "video.mp4",
    media_kind: "video",
    date_modified: null,
    date_created: null,
  },
];

describe("arePathsImageOnly", () => {
  it("accepts an image-only selection", () => {
    expect(arePathsImageOnly(files, ["image.jpg"])).toBe(true);
  });

  it("rejects audio, video and mixed selections", () => {
    expect(arePathsImageOnly(files, ["audio.flac"])).toBe(false);
    expect(arePathsImageOnly(files, ["video.mp4"])).toBe(false);
    expect(arePathsImageOnly(files, ["image.jpg", "audio.flac"])).toBe(false);
  });

  it("fails closed for empty or missing paths", () => {
    expect(arePathsImageOnly(files, [])).toBe(false);
    expect(arePathsImageOnly(files, ["missing.jpg"])).toBe(false);
  });
});

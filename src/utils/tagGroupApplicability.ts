// Coarse static mapping of file-extension → applicable ExifTool group-1
// prefixes.  Used by the "Add New Property" autocomplete to suppress the
// long tail of clearly-irrelevant suggestions (e.g. Vorbis tags on a JPEG).
//
// `-listx` does not expose per-tag file-type applicability, so this table is
// hand-maintained from ExifTool's documented format-to-group conventions.
// The lists are intentionally conservative: when an extension is unknown the
// caller should treat that as "no filter" rather than hiding everything.

const ALWAYS_ALLOWED = new Set<string>([
  "XMP",
  "Composite",
  "File",
  "ICC_Profile",
  "ICC-header",
  "ICC-meas",
  "ICC-view",
  "PrintIM",
]);

const IMAGE_GROUPS = new Set<string>([
  "IFD0",
  "IFD1",
  "ExifIFD",
  "GPS",
  "InteropIFD",
  "SubIFD",
  "SubIFD1",
  "SubIFD2",
  "MakerNotes",
  "IPTC",
  "Photoshop",
  "JFIF",
  "Adobe",
  "AdobeCM",
  "Ducky",
  "PNG",
  "PNG-pHYs",
  "PNG-tEXt",
  "PNG-iTXt",
  "PNG-zTXt",
  "GIF",
  "BMP",
  "WebP",
  "HEIC",
  "HEIF",
  "AVIF",
  "JPEG",
  "JPEG-2000",
  "JP2",
  "JUMBF",
  "MPF0",
  "MPImage1",
  "MPImage2",
  "CanonRaw",
  "CanonVRD",
  "CanonCustom",
  "Canon",
  "Nikon",
  "NikonCapture",
  "NikonScan",
  "NikonSettings",
  "Sony",
  "Olympus",
  "Pentax",
  "Panasonic",
  "Fujifilm",
  "FujiFilm",
  "Minolta",
  "Sigma",
  "Samsung",
  "Sanyo",
  "Casio",
  "Ricoh",
  "Apple",
  "GE",
  "DJI",
  "DNG",
  "AdobeDNG",
  "CameraIFD",
  "GeoTIFF",
  "EXIF",
  "MPF",
  "Stim",
  "FLIR",
]);

const AUDIO_GROUPS = new Set<string>([
  "ID3",
  "ID3v1",
  "ID3v1_Enh",
  "ID3v2_2",
  "ID3v2_3",
  "ID3v2_4",
  "Vorbis",
  "FLAC",
  "Theora",
  "Opus",
  "Ogg",
  "MPEG",
  "AAC",
  "AC3",
  "APE",
  "Audible",
  "AIFF",
  "RIFF",
  "RIFF-info",
  "RIFF-exif",
  "WAV",
  "MPC",
  "Lyrics3",
  "ASF",
  "iTunes",
]);

const VIDEO_GROUPS = new Set<string>([
  "QuickTime",
  "Keys",
  "ItemList",
  "UserData",
  "Track1",
  "Track2",
  "Track3",
  "Track4",
  "Track5",
  "Track6",
  "AudioKeys",
  "Matroska",
  "MPEG",
  "M2TS",
  "ASF",
  "WMV",
  "MXF",
  "RIFF",
  "Theora",
  "AVI1",
  "DV",
  "Flash",
  "FlashPix",
]);

const IMAGE_EXTS = new Set<string>([
  "jpg",
  "jpeg",
  "jpe",
  "jfif",
  "jif",
  "png",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
  "webp",
  "cr2",
  "cr3",
  "nef",
  "nrw",
  "arw",
  "rw2",
  "raf",
  "orf",
  "pef",
  "dng",
  "raw",
  "psd",
  "psb",
]);

const AUDIO_EXTS = new Set<string>([
  "mp3",
  "flac",
  "ogg",
  "oga",
  "opus",
  "m4a",
  "aac",
  "ape",
  "aiff",
  "aif",
  "wav",
  "wma",
  "mpc",
  "ac3",
]);

const VIDEO_EXTS = new Set<string>([
  "mp4",
  "m4v",
  "mov",
  "qt",
  "3gp",
  "3g2",
  "mkv",
  "webm",
  "avi",
  "wmv",
  "asf",
  "mts",
  "m2ts",
  "ts",
  "mxf",
  "flv",
  "f4v",
]);

function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return "";
  return filename.slice(dot + 1).toLowerCase();
}

function categoryOf(ext: string): "image" | "audio" | "video" | null {
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  return null;
}

function groupOf(tagKey: string): string {
  const colon = tagKey.indexOf(":");
  return colon < 0 ? "" : tagKey.slice(0, colon);
}

/** True when the group is in the always-allowed set (XMP-*, Composite, …). */
function isUniversal(group: string): boolean {
  if (ALWAYS_ALLOWED.has(group)) return true;
  // XMP namespaces all start with `XMP-` (XMP-dc, XMP-exif, XMP-photoshop, …).
  if (group.startsWith("XMP-")) return true;
  // ICC profile sub-groups.
  if (group.startsWith("ICC-") || group.startsWith("ICC_")) return true;
  return false;
}

/**
 * Filter a list of `Group:Name` tag keys down to those applicable to the
 * given filename's extension.  Unknown extensions → identity (no filter).
 */
export function filterTagsByFilename(
  tags: readonly string[],
  filename: string | undefined,
): string[] {
  if (!filename) return [...tags];
  const cat = categoryOf(extOf(filename));
  if (cat === null) return [...tags];
  const allowed =
    cat === "image"
      ? IMAGE_GROUPS
      : cat === "audio"
        ? AUDIO_GROUPS
        : VIDEO_GROUPS;
  return tags.filter((t) => {
    const g = groupOf(t);
    return isUniversal(g) || allowed.has(g);
  });
}

export interface TagGroupInfo {
  group: string;
}

export function filterTagInfosByFilename<T extends TagGroupInfo>(
  tags: readonly T[],
  filename: string | undefined,
): T[] {
  if (!filename) return [...tags];
  const cat = categoryOf(extOf(filename));
  if (cat === null) return [...tags];
  const allowed =
    cat === "image"
      ? IMAGE_GROUPS
      : cat === "audio"
        ? AUDIO_GROUPS
        : VIDEO_GROUPS;
  return tags.filter((t) => {
    const g = t.group;
    return isUniversal(g) || allowed.has(g);
  });
}

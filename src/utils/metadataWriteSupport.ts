import type { TagInfo } from "../types";

export type MetadataWriteOperation = "Set" | "DeleteExisting";

// Keep this display/planning mirror aligned with FORMAT_GROUP0_SUPPORT in
// tag_schema.rs. Actual writes are independently authorized by the Rust gate.
// These are raw ExifTool family-0 strings from -listx, not app aliases.
const FORMAT_GROUP0_SUPPORT: Readonly<Record<string, ReadonlySet<string>>> = {
  jpg: new Set([
    "JPEG",
    "JFIF",
    "Adobe",
    "Ducky",
    "EXIF",
    "XMP",
    "IPTC",
    "ICC_Profile",
    "Photoshop",
  ]),
  jpeg: new Set([
    "JPEG",
    "JFIF",
    "Adobe",
    "Ducky",
    "EXIF",
    "XMP",
    "IPTC",
    "ICC_Profile",
    "Photoshop",
  ]),
  jpe: new Set([
    "JPEG",
    "JFIF",
    "Adobe",
    "Ducky",
    "EXIF",
    "XMP",
    "IPTC",
    "ICC_Profile",
    "Photoshop",
  ]),
  jfif: new Set([
    "JPEG",
    "JFIF",
    "Adobe",
    "Ducky",
    "EXIF",
    "XMP",
    "IPTC",
    "ICC_Profile",
    "Photoshop",
  ]),
  jif: new Set([
    "JPEG",
    "JFIF",
    "Adobe",
    "Ducky",
    "EXIF",
    "XMP",
    "IPTC",
    "ICC_Profile",
    "Photoshop",
  ]),
  png: new Set(["PNG", "EXIF", "XMP", "ICC_Profile"]),
  gif: new Set(["GIF", "XMP", "ICC_Profile"]),
};

function extensionOf(fileName: string): string | null {
  const parts = fileName.replace(/\\/g, "/").split("/");
  const leaf = parts[parts.length - 1] ?? "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 && dot < leaf.length - 1
    ? leaf.slice(dot + 1).toLowerCase()
    : null;
}

/**
 * Frontend planning/display equivalent of Rust's sole write-eligibility gate.
 * Deleting an existing occurrence bypasses only the format/family-0 rule.
 */
export function tagInfoSupportsMetadataWrite(
  info: TagInfo,
  fileName: string | undefined,
  operation: MetadataWriteOperation,
): boolean {
  if (
    !info.writable ||
    info.kind.kind === "Binary" ||
    info.kind.kind === "Unknown"
  ) {
    return false;
  }
  if (operation === "DeleteExisting") return true;
  if (!fileName) return false;
  const extension = extensionOf(fileName);
  if (extension === null) return false;
  return (
    info.group0 !== undefined &&
    (FORMAT_GROUP0_SUPPORT[extension]?.has(info.group0) ?? false)
  );
}

export function filterTagInfosByFilename<T extends TagInfo>(
  tags: readonly T[],
  fileName: string | undefined,
): T[] {
  if (!fileName) return [...tags];
  return tags.filter((info) =>
    tagInfoSupportsMetadataWrite(info, fileName, "Set"),
  );
}

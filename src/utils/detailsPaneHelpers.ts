import type { PhotoInfo } from "../types";
import { metadataEntryToDisplayString } from "../draft";

export const formatMetadataValue = metadataEntryToDisplayString;

/** Format an OS timestamp (seconds since epoch, from Rust) into a readable string. */
export function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

/** OS-level metadata entries available from the directory walk. */
export function getOsEntries(
  photo: PhotoInfo,
): Array<[string, string, string]> {
  return [
    ["Filename", photo.filename, "filename"],
    ["Relative Path", photo.relative_path, "relative_path"],
    ["Date Modified", formatTimestamp(photo.date_modified), "date_modified"],
    ["Date Created", formatTimestamp(photo.date_created), "date_created"],
  ];
}

import type { FileInfo } from "../types";
import { formatMetadataValue as formatSemanticMetadataValue } from "../draft";

export const formatMetadataValue = (
  value: Parameters<typeof formatSemanticMetadataValue>[0]["value"],
) => formatSemanticMetadataValue({ value });

/** Format an OS timestamp (seconds since epoch, from Rust) into a readable string. */
export function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

/** OS-level metadata entries available from the directory walk. */
export function getOsEntries(file: FileInfo): Array<[string, string, string]> {
  return [
    ["Filename", file.filename, "filename"],
    ["Relative Path", file.relative_path, "relative_path"],
    ["Date Modified", formatTimestamp(file.date_modified), "date_modified"],
    ["Date Created", formatTimestamp(file.date_created), "date_created"],
  ];
}

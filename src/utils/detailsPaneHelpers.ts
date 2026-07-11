import type { ImageMetadataEntry, PhotoInfo, TagInfo } from "../types";
import { metadataEntryToDisplayString as metadataValueToDisplayString } from "../draft";
import {
  formatSchemaDefinitionIdForDiagnostics,
  schemaDefinitionIdToken,
} from "./schemaDefinitionId";
import type { TagInfoCacheEntry } from "../hooks/useTagInfo";

export const formatMetadataValue = metadataValueToDisplayString;

/** Format an OS timestamp (seconds since epoch, from Rust) into a readable string. */
export function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

/**
 * OS-level metadata entries (always available from the directory walk).
 */
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

/** Group key prefix (e.g. "IFD0" from "IFD0:Make"). Keys without a colon go in "Other". */
export function extractPrefix(key: string): string {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : "Other";
}

export interface MetadataEntry {
  id: ImageMetadataEntry["id"];
  identityToken: string;
  label: string;
  friendlyName: string;
  value: string;
}

export interface MetadataGroup {
  prefix: string;
  entries: MetadataEntry[];
}

/**
 * Group image metadata entries by their key prefix, preserving a stable order.
 * Returns groups sorted alphabetically by prefix, with "Other" last.
 */
export function groupImageMetadata(
  metadata: Record<string, ImageMetadataEntry>,
  tagInfos: Record<string, TagInfoCacheEntry> = {},
): MetadataGroup[] {
  const grouped = new Map<string, MetadataEntry[]>();

  const entries = Object.values(metadata).sort((a, b) =>
    schemaDefinitionIdToken(a.id).localeCompare(schemaDefinitionIdToken(b.id)),
  );

  for (const value of entries) {
    const token = schemaDefinitionIdToken(value.id);
    const info = tagInfos[token];
    const tagInfo: TagInfo | null = info && info !== "loading" ? info : null;
    const prefix = tagInfo?.group ?? value.id.table;
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    const label = tagInfo?.name ?? value.id.tag_id;
    grouped.get(prefix)!.push({
      id: value.id,
      identityToken: token,
      label,
      friendlyName: tagInfo
        ? `${tagInfo.group}:${tagInfo.name}`
        : formatSchemaDefinitionIdForDiagnostics(value.id),
      value: formatMetadataValue(value),
    });
  }

  const groups: MetadataGroup[] = [];
  const sortedPrefixes = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  for (const prefix of sortedPrefixes) {
    groups.push({ prefix, entries: grouped.get(prefix)! });
  }

  return groups;
}

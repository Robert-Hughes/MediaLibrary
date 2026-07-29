import type { SchemaDefinitionId, TagInfo } from "../types";
import {
  _clearTagInfoCache,
  _ensureTagInfoCacheEntry as ensureExact,
  _setTagInfoCacheEntry as setExact,
} from "../hooks/useTagInfo";
import { testIdForFriendlyName } from "./testIds";

type CacheEntry = "loading" | TagInfo | null;

export { _clearTagInfoCache };

function withDefaultGroup0<T extends TagInfo | Omit<TagInfo, "id">>(
  value: T,
): T {
  if (value.group0 !== undefined) return value;
  const table = "id" in value ? value.id.table : "";
  const group0 = table.startsWith("XMP::")
    ? "XMP"
    : table.startsWith("IPTC::")
      ? "IPTC"
      : value.group.startsWith("XMP-")
        ? "XMP"
        : "EXIF";
  return { ...value, group0 };
}

export function _setTagInfoCacheEntry(
  key: SchemaDefinitionId | string,
  value: CacheEntry | Omit<TagInfo, "id">,
): void {
  const id = typeof key === "string" ? testIdForFriendlyName(key) : key;
  setExact(
    id,
    value === "loading" || value === null ? value : withDefaultGroup0(value),
  );
}

export function _ensureTagInfoCacheEntry(
  key: SchemaDefinitionId | string,
  value: TagInfo | Omit<TagInfo, "id">,
): void {
  const id = typeof key === "string" ? testIdForFriendlyName(key) : key;
  ensureExact(id, withDefaultGroup0(value));
}

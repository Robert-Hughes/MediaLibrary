import type { SchemaDefinitionId, TagInfo } from "../types";
import {
  _clearTagInfoCache,
  _ensureTagInfoCacheEntry as ensureExact,
  _setTagInfoCacheEntry as setExact,
} from "../hooks/useTagInfo";
import { testIdForFriendlyName } from "./testIds";

type CacheEntry = "loading" | TagInfo | null;

export { _clearTagInfoCache };

export function _setTagInfoCacheEntry(
  key: SchemaDefinitionId | string,
  value: CacheEntry | Omit<TagInfo, "id">,
): void {
  const id = typeof key === "string" ? testIdForFriendlyName(key) : key;
  setExact(id, value);
}

export function _ensureTagInfoCacheEntry(
  key: SchemaDefinitionId | string,
  value: TagInfo | Omit<TagInfo, "id">,
): void {
  const id = typeof key === "string" ? testIdForFriendlyName(key) : key;
  ensureExact(id, value);
}

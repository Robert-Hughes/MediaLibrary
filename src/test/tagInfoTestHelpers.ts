import type { SchemaDefinitionId, TagInfo } from "../types";
import {
  _clearTagInfoCache,
  _ensureTagInfoCacheEntry,
  _ensureTagInfoLabel,
  _setTagInfoCacheEntry as setExact,
} from "../hooks/useTagInfo";
import { testIdForFriendlyName } from "./testIds";

type CacheEntry = "loading" | TagInfo | null;

export { _clearTagInfoCache, _ensureTagInfoCacheEntry, _ensureTagInfoLabel };
export function _setTagInfoCacheEntry(
  key: SchemaDefinitionId | string,
  value: CacheEntry | Omit<TagInfo, "id">,
): void {
  setExact(typeof key === "string" ? testIdForFriendlyName(key) : key, value);
}

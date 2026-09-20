import { useEffect, useMemo, useState } from "react";
import type { SchemaDefinitionId, TagInfo } from "../types";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import {
  _clearTagSchemaRegistryForTests,
  _ensureTagInfoForTests,
  _setTagInfoForTests,
  getTagInfoExact,
  subscribeTagSchemaRegistry,
  tagSchemaRegistryIsInstalled,
} from "../tagSchemaRegistry";

export type TagInfoCacheEntry = "loading" | TagInfo | null;

/**
 * Resolve exact schema IDs from the frontend registry installed at startup.
 * Kept async for callers that already await this helper; no IPC occurs here.
 */
export async function resolveTagInfosExact(
  ids: readonly SchemaDefinitionId[],
): Promise<Record<string, TagInfo | null>> {
  const result: Record<string, TagInfo | null> = {};
  for (const id of ids) {
    const token = schemaDefinitionIdToken(id);
    if (token in result) continue;
    result[token] = getTagInfoExact(id);
  }
  return result;
}

/**
 * Returns the exact TagInfo from the frontend's process-lifetime schema
 * registry. "loading" is possible only before startup installation completes.
 */
export function useTagInfo(
  id: SchemaDefinitionId | null | undefined,
): TagInfoCacheEntry {
  const [, setTick] = useState(0);
  useEffect(
    () => subscribeTagSchemaRegistry(() => setTick((value) => value + 1)),
    [],
  );

  if (!id) return null;
  if (!tagSchemaRegistryIsInstalled()) return "loading";
  return getTagInfoExact(id);
}

/**
 * Exact batch lookup from the already-installed frontend registry.
 */
export function useTagInfos(
  ids: readonly SchemaDefinitionId[],
): Record<string, TagInfoCacheEntry> {
  const [, setTick] = useState(0);
  useEffect(
    () => subscribeTagSchemaRegistry(() => setTick((value) => value + 1)),
    [],
  );

  return useMemo(() => {
    const result: Record<string, TagInfoCacheEntry> = {};
    const installed = tagSchemaRegistryIsInstalled();
    for (const id of ids) {
      const token = schemaDefinitionIdToken(id);
      if (token in result) continue;
      result[token] = installed ? getTagInfoExact(id) : "loading";
    }
    return result;
  }, [ids]);
}

// Test compatibility helpers. Production installs the complete registry once
// from App startup and never mutates individual entries.
export function _clearTagInfoCache(): void {
  _clearTagSchemaRegistryForTests();
}

export function _setTagInfoCacheEntry(
  id: SchemaDefinitionId,
  value: TagInfoCacheEntry | Omit<TagInfo, "id">,
): void {
  if (value === "loading") {
    _clearTagSchemaRegistryForTests();
    return;
  }
  _setTagInfoForTests(id, value);
}

export function _ensureTagInfoCacheEntry(
  id: SchemaDefinitionId,
  value: TagInfo | Omit<TagInfo, "id">,
): void {
  _ensureTagInfoForTests(id, value);
}

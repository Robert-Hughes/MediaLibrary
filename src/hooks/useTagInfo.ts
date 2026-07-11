// Schema lookup hook with per-session cache.
//
// Calls the Tauri `get_tag_info` command and caches results in a
// module-level Map keyed by `schemaDefinitionIdToken(id)`.
// Repeated lookups during a session hit the cache.
// If the exact SchemaDefinitionId was not found, the cache entry is set to `null`
// (invocation failures also currently settle as `null` after logging the exact ID).
//
// Editors call this to decide which kind-specific control to render.

import { useEffect, useState, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TagInfo, SchemaDefinitionId } from "../types";
import {
  schemaDefinitionIdToken,
  formatSchemaDefinitionIdForDiagnostics,
} from "../utils/schemaDefinitionId";

export type TagInfoCacheEntry = "loading" | TagInfo | null;

const cache = new Map<string, TagInfoCacheEntry>();
const subscribers = new Map<string, Set<() => void>>();

function notify(key: string) {
  subscribers.get(key)?.forEach((cb) => cb());
}

function subscribe(key: string, cb: () => void): () => void {
  if (!subscribers.has(key)) subscribers.set(key, new Set());
  subscribers.get(key)!.add(cb);
  return () => {
    const s = subscribers.get(key);
    if (s) {
      s.delete(cb);
      if (s.size === 0) subscribers.delete(key);
    }
  };
}

async function fetchTagInfo(
  id: SchemaDefinitionId,
  token: string,
): Promise<void> {
  cache.set(token, "loading");
  notify(token);
  try {
    const result = (await invoke("get_tag_info", {
      id,
    })) as TagInfo | null;
    if (cache.get(token) === "loading") cache.set(token, result);
  } catch (e) {
    console.error(
      `[useTagInfo] get_tag_info(${formatSchemaDefinitionIdForDiagnostics(id)}) failed:`,
      e,
    );
    if (cache.get(token) === "loading") cache.set(token, null);
  }
  notify(token);
}

/**
 * Returns the cached TagInfo for `id`, kicking off a Tauri lookup on first
 * use. Re-renders the caller when the result lands.
 *
 * - `"loading"` — fetch in flight (first call)
 * - `null`      — the exact SchemaDefinitionId was not found
 * - `TagInfo`   — fetch completed; schema available
 */
export function useTagInfo(
  id: SchemaDefinitionId | null | undefined,
): TagInfoCacheEntry {
  const [, setTick] = useState(0);

  const token = id ? schemaDefinitionIdToken(id) : null;
  const requestRef = useRef<{
    token: string;
    id: SchemaDefinitionId;
  } | null>(null);
  if (id && token && requestRef.current?.token !== token) {
    requestRef.current = { token, id };
  }

  useEffect(() => {
    if (!token) return;
    if (!cache.has(token)) {
      void fetchTagInfo(requestRef.current!.id, token);
    }
    return subscribe(token, () => setTick((n) => n + 1));
  }, [token]);

  if (!id || !token) return null;
  return cache.has(token) ? cache.get(token)! : "loading";
}

/**
 * Returns a record mapping each tag ID in `ids` to its CacheEntry.
 * Deduplicates and sorts the keys to ensure stable subscriptions.
 * Kicks off Tauri schema lookups for any uncached keys in batch.
 */
export function useTagInfos(
  ids: readonly SchemaDefinitionId[],
): Record<string, TagInfoCacheEntry> {
  const [, setTick] = useState(0);

  const prevTokensRef = useRef<string[]>([]);

  const stableData = useMemo(() => {
    const uniqueMap = new Map<string, SchemaDefinitionId>();
    for (const id of ids) {
      if (!id) continue;
      const token = schemaDefinitionIdToken(id);
      if (!uniqueMap.has(token)) {
        uniqueMap.set(token, id);
      }
    }
    const sortedTokens = Array.from(uniqueMap.keys()).sort();

    if (
      prevTokensRef.current.length === sortedTokens.length &&
      prevTokensRef.current.every((k, i) => k === sortedTokens[i])
    ) {
      return { tokens: prevTokensRef.current, uniqueMap };
    }
    prevTokensRef.current = sortedTokens;
    return { tokens: sortedTokens, uniqueMap };
  }, [ids]);

  useEffect(() => {
    if (stableData.tokens.length === 0) return;

    for (const token of stableData.tokens) {
      if (!cache.has(token)) {
        const id = stableData.uniqueMap.get(token)!;
        void fetchTagInfo(id, token);
      }
    }

    const cleanups = stableData.tokens.map((token) =>
      subscribe(token, () => setTick((n) => n + 1)),
    );

    return () => {
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [stableData]);

  const result: Record<string, TagInfoCacheEntry> = {};
  for (const token of stableData.tokens) {
    result[token] = cache.has(token) ? cache.get(token)! : "loading";
  }
  return result;
}

// ── Test helpers ────────────────────────────────────────────────────────────

export function _clearTagInfoCache(): void {
  cache.clear();
  subscribers.clear();
}

export function _setTagInfoCacheEntry(
  id: SchemaDefinitionId,
  value: TagInfoCacheEntry | Omit<TagInfo, "id">,
): void {
  const token = schemaDefinitionIdToken(id);
  if (value && typeof value === "object" && !("id" in value)) {
    cache.set(token, { ...value, id } as TagInfo);
  } else {
    cache.set(token, value as TagInfoCacheEntry);
  }
  notify(token);
}

export function _ensureTagInfoCacheEntry(
  id: SchemaDefinitionId,
  value: TagInfo | Omit<TagInfo, "id">,
): void {
  const token = schemaDefinitionIdToken(id);
  if (!cache.has(token)) {
    if (value && !("id" in value)) {
      cache.set(token, { ...value, id } as TagInfo);
    } else {
      cache.set(token, value as TagInfo);
    }
    notify(token);
  }
}

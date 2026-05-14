// Schema lookup hook with per-session cache.
//
// Calls the Tauri `get_tag_info` command (Phase 2 backend) and caches results
// in a module-level Map keyed by `Group:Name`.  Repeated lookups during a
// session hit the cache.  A failed registry build returns `null`; an unknown
// tag also returns `null` (caller treats both as "no schema, use text
// fallback").
//
// Phase 4 editors call this to decide which kind-specific control to render.

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TagInfo } from "../types";

type CacheEntry = "loading" | TagInfo | null;
const cache = new Map<string, CacheEntry>();
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

async function fetchTagInfo(key: string): Promise<void> {
  cache.set(key, "loading");
  notify(key);
  try {
    const result = (await invoke("get_tag_info", { tag: key })) as TagInfo | null;
    cache.set(key, result);
  } catch (e) {
    console.error(`[useTagInfo] get_tag_info(${key}) failed:`, e);
    cache.set(key, null);
  }
  notify(key);
}

/**
 * Returns the cached TagInfo for `key`, kicking off a Tauri lookup on first
 * use.  Re-renders the caller when the result lands.
 *
 * - `"loading"` — fetch in flight (first call)
 * - `null`      — fetch completed; tag not in registry, or registry failed
 * - `TagInfo`   — fetch completed; schema available
 */
export function useTagInfo(key: string | null | undefined): CacheEntry {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!key) return;
    if (!cache.has(key)) {
      void fetchTagInfo(key);
    }
    return subscribe(key, () => setTick((n) => n + 1));
  }, [key]);

  if (!key) return null;
  return cache.get(key) ?? "loading";
}

// ── Test helpers ────────────────────────────────────────────────────────────

export function _clearTagInfoCache(): void {
  cache.clear();
  subscribers.clear();
}

export function _setTagInfoCacheEntry(key: string, value: CacheEntry): void {
  cache.set(key, value);
  notify(key);
}

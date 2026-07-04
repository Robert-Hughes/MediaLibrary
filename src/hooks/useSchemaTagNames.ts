import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type State = "loading" | string[];

let cached: State = "loading";
let fetched = false;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((cb) => cb());
}

async function fetchTagNames(): Promise<void> {
  try {
    const result = (await invoke("list_schema_tags")) as string[] | null;
    cached = result ?? [];
  } catch (e) {
    console.error("[useSchemaTagNames] list_schema_tags failed:", e);
    cached = [];
  }
  notify();
}

/**
 * Returns the full sorted list of `Group:Name` keys from the schema registry.
 * Fetches once per session; subsequent calls return the cached value.
 */
export function useSchemaTagNames(): State {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!fetched) {
      fetched = true;
      void fetchTagNames();
    }
    const cb = () => setTick((n) => n + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  return cached;
}

// ── Test helpers ─────────────────────────────────────────────────────────────

export function _resetSchemaTagNamesCache(): void {
  cached = "loading";
  fetched = false;
  subscribers.clear();
}

export function _setSchemaTagNamesCache(tags: string[]): void {
  cached = tags;
  fetched = true;
  notify();
}

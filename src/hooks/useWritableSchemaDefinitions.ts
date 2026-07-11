import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TagInfo } from "../types";

type State = "loading" | TagInfo[];

let cached: State = "loading";
let fetched = false;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((cb) => cb());
}

async function fetchDefinitions(): Promise<void> {
  try {
    const result = (await invoke("list_writable_schema_definitions")) as
      TagInfo[] | null;
    cached = result ?? [];
  } catch (e) {
    console.error("[useWritableSchemaDefinitions] schema lookup failed:", e);
    cached = [];
  }
  notify();
}

/** Returns every exact writable definition for the Add New Property picker. */
export function useWritableSchemaDefinitions(): State {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!fetched) {
      fetched = true;
      void fetchDefinitions();
    }
    const cb = () => setTick((n) => n + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, []);

  return cached;
}

// Test-only cache controls. Inputs remain exact TagInfo records.
export function _resetWritableSchemaDefinitionsCache(): void {
  cached = "loading";
  fetched = false;
  subscribers.clear();
}

export function _setWritableSchemaDefinitionsCache(tags: TagInfo[]): void {
  cached = tags;
  fetched = true;
  notify();
}

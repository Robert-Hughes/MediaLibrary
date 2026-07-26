import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { TagInfo } from "../types";
import { tagInfoSupportsMetadataWrite } from "../utils/metadataWriteSupport";

type State = "loading" | TagInfo[];
type SchemaDefinitionsInvoke = (
  command: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

let cached: State = "loading";
let fetched = false;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((cb) => cb());
}

async function fetchDefinitions(
  invokeCommand: SchemaDefinitionsInvoke,
): Promise<void> {
  try {
    const result = (await invokeCommand("list_writable_schema_definitions")) as
      TagInfo[] | null;
    cached = (result ?? []).filter(tagInfoSupportsMetadataWrite);
  } catch (e) {
    console.error("[useWritableSchemaDefinitions] schema lookup failed:", e);
    cached = [];
  }
  notify();
}

/** Returns every exact supported writable definition for Add New Property. */
export function useWritableSchemaDefinitions(
  invokeCommand: SchemaDefinitionsInvoke = invoke,
): State {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!fetched) {
      fetched = true;
      void fetchDefinitions(invokeCommand);
    }
    const cb = () => setTick((n) => n + 1);
    subscribers.add(cb);
    return () => {
      subscribers.delete(cb);
    };
  }, [invokeCommand]);

  return cached;
}

// Test-only cache controls. Inputs remain exact TagInfo records.
export function _resetWritableSchemaDefinitionsCache(): void {
  cached = "loading";
  fetched = false;
  subscribers.clear();
}

export function _setWritableSchemaDefinitionsCache(tags: TagInfo[]): void {
  cached = tags.filter(tagInfoSupportsMetadataWrite);
  fetched = true;
  notify();
}

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
let generation = 0;
const subscribers = new Set<() => void>();

function notify() {
  subscribers.forEach((cb) => cb());
}

async function fetchDefinitions(
  invokeCommand: SchemaDefinitionsInvoke,
  requestedGeneration: number,
): Promise<void> {
  let next: TagInfo[];
  try {
    const result = (await invokeCommand("list_writable_schema_definitions")) as
      TagInfo[] | null;
    next = (result ?? []).filter((info) =>
      tagInfoSupportsMetadataWrite(info, undefined, "DeleteExisting"),
    );
  } catch (e) {
    console.error("[useWritableSchemaDefinitions] schema lookup failed:", e);
    next = [];
  }
  if (requestedGeneration !== generation) return;
  cached = next;
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
      void fetchDefinitions(invokeCommand, generation);
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
  generation += 1;
  cached = "loading";
  fetched = false;
  subscribers.clear();
}

export function _setWritableSchemaDefinitionsCache(tags: TagInfo[]): void {
  cached = tags
    .map((info) => {
      if (info.group0 !== undefined) return info;
      const group0 = info.id.table.startsWith("XMP::")
        ? "XMP"
        : info.id.table.startsWith("IPTC::")
          ? "IPTC"
          : info.group.startsWith("XMP-")
            ? "XMP"
            : "EXIF";
      return { ...info, group0 };
    })
    .filter((info) =>
      tagInfoSupportsMetadataWrite(info, undefined, "DeleteExisting"),
    );
  fetched = true;
  notify();
}

import type { SchemaDefinitionId, TagInfo } from "./types";
import { schemaDefinitionIdToken } from "./utils/schemaDefinitionId";

const definitions = new Map<string, TagInfo>();
const subscribers = new Set<() => void>();
let installed = false;

function notify(): void {
  subscribers.forEach((subscriber) => subscriber());
}

export function installTagSchemaRegistry(infos: readonly TagInfo[]): void {
  const next = new Map<string, TagInfo>();
  for (const info of infos) {
    const token = schemaDefinitionIdToken(info.id);
    if (next.has(token)) {
      throw new Error(`Duplicate exact schema definition '${token}'`);
    }
    next.set(token, info);
  }

  definitions.clear();
  for (const [token, info] of next) definitions.set(token, info);
  installed = true;
  notify();
}

export function tagSchemaRegistryIsInstalled(): boolean {
  return installed;
}

export function getTagInfoExact(
  id: SchemaDefinitionId | null | undefined,
): TagInfo | null {
  if (!id || !installed) return null;
  return definitions.get(schemaDefinitionIdToken(id)) ?? null;
}

export function getTagInfosExact(
  ids: readonly SchemaDefinitionId[],
): Record<string, TagInfo | null> {
  const result: Record<string, TagInfo | null> = {};
  for (const id of ids) {
    const token = schemaDefinitionIdToken(id);
    if (result[token] !== undefined) continue;
    result[token] = installed ? (definitions.get(token) ?? null) : null;
  }
  return result;
}

export function allTagInfos(): readonly TagInfo[] {
  return installed ? Array.from(definitions.values()) : [];
}

export function subscribeTagSchemaRegistry(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

// Test support. Production installs the complete registry exactly once at startup.
export function _clearTagSchemaRegistryForTests(): void {
  definitions.clear();
  installed = false;
  subscribers.clear();
}

export function _setTagInfoForTests(
  id: SchemaDefinitionId,
  value: TagInfo | Omit<TagInfo, "id"> | null,
): void {
  if (!installed) installed = true;
  const token = schemaDefinitionIdToken(id);
  if (value === null) {
    definitions.delete(token);
  } else if ("id" in value) {
    definitions.set(token, value);
  } else {
    definitions.set(token, { ...value, id });
  }
  notify();
}

export function _ensureTagInfoForTests(
  id: SchemaDefinitionId,
  value: TagInfo | Omit<TagInfo, "id">,
): void {
  if (!installed) installed = true;
  const token = schemaDefinitionIdToken(id);
  if (!definitions.has(token)) {
    definitions.set(token, "id" in value ? value : { ...value, id });
    notify();
  }
}

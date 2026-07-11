import type { SchemaDefinitionId, TagInfo } from "../types";

export function schemaDefinitionIdEquals(
  a: SchemaDefinitionId,
  b: SchemaDefinitionId,
): boolean {
  return (
    a.table === b.table &&
    a.tag_id === b.tag_id &&
    (a.index ?? null) === (b.index ?? null)
  );
}

/**
 * Internal JavaScript collection/React-key token only. Domain APIs, persisted
 * data and Tauri commands must always carry the original SchemaDefinitionId.
 */
export function schemaDefinitionIdToken(id: SchemaDefinitionId): string {
  return JSON.stringify([id.table, id.tag_id, id.index ?? null]);
}

export function schemaDefinitionIdFromToken(
  token: string,
): SchemaDefinitionId | null {
  try {
    const value = JSON.parse(token) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      typeof value[0] !== "string" ||
      typeof value[1] !== "string"
    )
      return null;
    const index = value[2];
    if (
      index !== null &&
      (!Number.isInteger(index) || typeof index !== "number")
    )
      return null;
    return {
      table: value[0],
      tag_id: value[1],
      ...(index === null ? {} : { index }),
    };
  } catch {
    return null;
  }
}

export function formatSchemaDefinitionIdForDiagnostics(
  id: SchemaDefinitionId,
): string {
  return `${id.table} / ${id.tag_id}${id.index == null ? "" : ` / index ${id.index}`}`;
}

export function tagInfoDisplayName(info: TagInfo): string {
  return `${info.group}:${info.name}`;
}

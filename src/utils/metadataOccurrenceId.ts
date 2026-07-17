import type { MetadataOccurrenceId } from "../types/generated/MetadataOccurrenceId";
import { compareUnicodeScalarStrings } from "./unicodeOrdering";

export function metadataOccurrenceIdEquals(
  a: MetadataOccurrenceId,
  b: MetadataOccurrenceId,
): boolean {
  return (
    (a.document ?? null) === (b.document ?? null) &&
    a.path === b.path &&
    a.runtime_tag_id === b.runtime_tag_id &&
    a.tag_id_scope.table === b.tag_id_scope.table &&
    a.tag_id_scope.tag_id === b.tag_id_scope.tag_id &&
    (a.tag_id_scope.index ?? null) === (b.tag_id_scope.index ?? null) &&
    a.copy === b.copy
  );
}

/**
 * Lexicographic MetadataOccurrenceId ordering matching Rust `str` for valid
 * Unicode scalar strings, with null documents first and copy compared numerically.
 */
export function compareMetadataOccurrenceIds(
  a: MetadataOccurrenceId,
  b: MetadataOccurrenceId,
): number {
  const aDocument = a.document ?? null;
  const bDocument = b.document ?? null;
  if (aDocument === null && bDocument !== null) return -1;
  if (aDocument !== null && bDocument === null) return 1;
  if (aDocument !== null && bDocument !== null) {
    const documentOrder = compareUnicodeScalarStrings(aDocument, bDocument);
    if (documentOrder !== 0) return documentOrder;
  }
  const pathOrder = compareUnicodeScalarStrings(a.path, b.path);
  if (pathOrder !== 0) return pathOrder;
  const runtimeTagOrder = compareUnicodeScalarStrings(
    a.runtime_tag_id,
    b.runtime_tag_id,
  );
  if (runtimeTagOrder !== 0) return runtimeTagOrder;
  const tableOrder = compareUnicodeScalarStrings(
    a.tag_id_scope.table,
    b.tag_id_scope.table,
  );
  if (tableOrder !== 0) return tableOrder;
  const wrappedTagOrder = compareUnicodeScalarStrings(
    a.tag_id_scope.tag_id,
    b.tag_id_scope.tag_id,
  );
  if (wrappedTagOrder !== 0) return wrappedTagOrder;
  const aIndex = a.tag_id_scope.index ?? null;
  const bIndex = b.tag_id_scope.index ?? null;
  if (aIndex === null && bIndex !== null) return -1;
  if (aIndex !== null && bIndex === null) return 1;
  if (aIndex !== null && bIndex !== null && aIndex !== bIndex) {
    return aIndex - bIndex;
  }
  return a.copy - b.copy;
}

/**
 * Internal JavaScript collection/React-key token only. Domain APIs, persisted
 * data and Tauri commands must always carry the original MetadataOccurrenceId.
 */
export function metadataOccurrenceIdToken(id: MetadataOccurrenceId): string {
  return JSON.stringify([
    id.document ?? null,
    id.path,
    id.runtime_tag_id,
    [
      id.tag_id_scope.table,
      id.tag_id_scope.tag_id,
      id.tag_id_scope.index ?? null,
    ],
    id.copy,
  ]);
}

export function metadataOccurrenceIdFromToken(
  token: string,
): MetadataOccurrenceId {
  let parsed: unknown;
  try {
    parsed = JSON.parse(token);
  } catch {
    throw new Error("Invalid metadata occurrence ID token: expected JSON");
  }

  if (!Array.isArray(parsed) || parsed.length !== 5) {
    throw new Error(
      "Invalid metadata occurrence ID token: expected a five-element array",
    );
  }

  const [document, path, runtimeTagId, scope, copy] = parsed;
  if (document !== null && typeof document !== "string") {
    throw new Error(
      "Invalid metadata occurrence ID token: document must be null or a string",
    );
  }
  if (typeof path !== "string") {
    throw new Error(
      "Invalid metadata occurrence ID token: path must be a string",
    );
  }
  if (typeof runtimeTagId !== "string") {
    throw new Error(
      "Invalid metadata occurrence ID token: runtime tag ID must be a string",
    );
  }
  if (!Array.isArray(scope) || scope.length !== 3) {
    throw new Error(
      "Invalid metadata occurrence ID token: tag ID scope must be a three-element array",
    );
  }
  const [table, wrappedTagId, index] = scope;
  if (typeof table !== "string" || typeof wrappedTagId !== "string") {
    throw new Error(
      "Invalid metadata occurrence ID token: tag ID scope table and tag ID must be strings",
    );
  }
  if (index !== null && (!Number.isInteger(index) || (index as number) < 0)) {
    throw new Error(
      "Invalid metadata occurrence ID token: tag ID scope index must be null or a non-negative integer",
    );
  }
  if (!Number.isInteger(copy) || (copy as number) < 0) {
    throw new Error(
      "Invalid metadata occurrence ID token: copy must be a non-negative integer",
    );
  }

  return {
    document,
    path,
    runtime_tag_id: runtimeTagId,
    tag_id_scope: {
      table,
      tag_id: wrappedTagId,
      index: index as number | null,
    },
    copy: copy as number,
  };
}

/** Human-readable diagnostics only; this string is not occurrence identity. */
export function formatMetadataOccurrenceIdForDiagnostics(
  id: MetadataOccurrenceId,
): string {
  return `document ${id.document ?? "<main>"} / path ${id.path} / runtime tag ${id.runtime_tag_id} / wrapped scope ${id.tag_id_scope.table} ID ${id.tag_id_scope.tag_id} index ${id.tag_id_scope.index ?? "<none>"} / copy ${id.copy}`;
}

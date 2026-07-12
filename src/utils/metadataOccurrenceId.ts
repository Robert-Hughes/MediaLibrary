import type { MetadataOccurrenceId } from "../types/generated/MetadataOccurrenceId";

export function metadataOccurrenceIdEquals(
  a: MetadataOccurrenceId,
  b: MetadataOccurrenceId,
): boolean {
  return (
    (a.document ?? null) === (b.document ?? null) &&
    a.path === b.path &&
    a.tag_id === b.tag_id &&
    a.copy === b.copy
  );
}

/**
 * Internal JavaScript collection/React-key token only. Domain APIs, persisted
 * data and Tauri commands must always carry the original MetadataOccurrenceId.
 */
export function metadataOccurrenceIdToken(id: MetadataOccurrenceId): string {
  return JSON.stringify([id.document ?? null, id.path, id.tag_id, id.copy]);
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

  if (!Array.isArray(parsed) || parsed.length !== 4) {
    throw new Error(
      "Invalid metadata occurrence ID token: expected a four-element array",
    );
  }

  const [document, path, tagId, copy] = parsed;
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
  if (typeof tagId !== "string") {
    throw new Error(
      "Invalid metadata occurrence ID token: tag ID must be a string",
    );
  }
  if (!Number.isInteger(copy) || (copy as number) < 0) {
    throw new Error(
      "Invalid metadata occurrence ID token: copy must be a non-negative integer",
    );
  }

  return { document, path, tag_id: tagId, copy: copy as number };
}

/** Human-readable diagnostics only; this string is not occurrence identity. */
export function formatMetadataOccurrenceIdForDiagnostics(
  id: MetadataOccurrenceId,
): string {
  return `document ${id.document ?? "<main>"} / path ${id.path} / tag ${id.tag_id} / copy ${id.copy}`;
}

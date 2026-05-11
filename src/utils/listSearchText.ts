/** Trimmed, lowercased query for case-insensitive matching; empty => no filter. */
export function normalizeListSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function listSearchQueryIsActive(query: string): boolean {
  return normalizeListSearchQuery(query).length > 0;
}

/** Case-insensitive haystack contains needle (needle is already normalized lowercased). */
export function haystackContainsNormalized(haystack: string, normalizedNeedle: string): boolean {
  if (!normalizedNeedle) return true;
  return haystack.toLowerCase().includes(normalizedNeedle);
}

/**
 * Split display `text` into segments for highlighting `normalizedQuery` (lowercase).
 * Preserves original casing in segment text.
 */
export function splitForHighlight(
  text: string,
  normalizedQuery: string,
): Array<{ text: string; match: boolean }> {
  if (!normalizedQuery) {
    return [{ text, match: false }];
  }
  const lower = text.toLowerCase();
  const q = normalizedQuery;
  const len = q.length;
  const parts: Array<{ text: string; match: boolean }> = [];
  let i = 0;
  while (i < text.length) {
    const idx = lower.indexOf(q, i);
    if (idx === -1) {
      parts.push({ text: text.slice(i), match: false });
      break;
    }
    if (idx > i) {
      parts.push({ text: text.slice(i, idx), match: false });
    }
    parts.push({ text: text.slice(idx, idx + len), match: true });
    i = idx + len;
  }
  return parts.length > 0 ? parts : [{ text, match: false }];
}

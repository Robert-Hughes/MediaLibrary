import type { MediaKind } from "../types";

const MEDIA_KINDS = [
  "image",
  "audio",
  "video",
] as const satisfies readonly MediaKind[];
const MEDIA_KIND_SET = new Set<string>(MEDIA_KINDS);

export interface ParsedSearchQuery {
  raw: string;
  freeText: string;
  normalizedFreeText: string;
  filters: {
    hasEdits: boolean;
    mediaKinds: MediaKind[];
  };
  filterKey: string;
}

function isMediaKind(value: string): value is MediaKind {
  return MEDIA_KIND_SET.has(value);
}

/**
 * Parse the list-search query into residual substring text and structured
 * filters. Operators are complete, whitespace-delimited, case-insensitive
 * tokens. Unrecognised tokens remain searchable text.
 */
export function parseSearchQuery(raw: string): ParsedSearchQuery {
  const freeTextTokens: string[] = [];
  const selectedKinds = new Set<MediaKind>();
  let hasEdits = false;

  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    const normalizedToken = token.toLowerCase();
    if (normalizedToken === "has:edits") {
      hasEdits = true;
      continue;
    }
    if (normalizedToken.startsWith("kind:")) {
      const value = normalizedToken.slice("kind:".length);
      if (isMediaKind(value)) {
        selectedKinds.add(value);
        continue;
      }
    }
    freeTextTokens.push(token);
  }

  const mediaKinds = MEDIA_KINDS.filter((kind) => selectedKinds.has(kind));
  const freeText = freeTextTokens.join(" ");
  const normalizedFreeText = freeText.toLowerCase();
  const filterKey = `hasEdits=${hasEdits ? "1" : "0"};mediaKinds=${mediaKinds.join(",")}`;

  return {
    raw,
    freeText,
    normalizedFreeText,
    filters: { hasEdits, mediaKinds },
    filterKey,
  };
}

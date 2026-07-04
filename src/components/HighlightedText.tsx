import {
  normalizeListSearchQuery,
  splitForHighlight,
} from "../utils/listSearchText";

interface Props {
  text: string;
  /** Raw query; empty/whitespace shows plain text without marks. */
  searchQuery: string;
}

/**
 * Renders `text` with case-insensitive matches of `searchQuery` wrapped in {@link mark.search-highlight}.
 */
export function HighlightedText({ text, searchQuery }: Props) {
  const q = normalizeListSearchQuery(searchQuery);
  const parts = splitForHighlight(text, q);
  return (
    <>
      {parts.map((seg, i) =>
        seg.match ? (
          <mark key={i} className="search-highlight">
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

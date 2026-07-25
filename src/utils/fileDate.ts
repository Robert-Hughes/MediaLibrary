/**
 * Format a Unix-seconds timestamp as the date string shown in FileList rows
 * and used in the search-index haystack.  Returns the em-dash placeholder
 * for null timestamps so the haystack carries the same glyph the user sees
 * (allowing them to search for "—" or any locale-formatted date fragment).
 */
export function formatFileRowDate(ts: number | null): string {
  if (ts === null) return "—";
  return new Date(ts * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

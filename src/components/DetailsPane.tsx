import { useMemo, useState } from "react";
import type { PhotoInfo, ImageMetadataState, Variant } from "../types";
import { HighlightedText } from "./HighlightedText";
import { haystackContainsNormalized, normalizeListSearchQuery } from "../utils/listSearchText";

interface Props {
  photo: PhotoInfo;
  metadata: ImageMetadataState;
}

/** Format an OS timestamp (seconds since epoch, from Rust) into a readable string. */
function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

/** Recursively format a Variant value for display. */
function formatVariant(value: Variant): string {
  if (Array.isArray(value)) {
    return value.map(formatVariant).join(", ");
  }
  if (typeof value === "number") return String(value);
  return String(value);
}

/**
 * OS-level metadata entries (always available from the directory walk).
 */
function getOsEntries(photo: PhotoInfo): Array<[string, string]> {
  return [
    ["Filename", photo.filename],
    ["Relative Path", photo.relative_path],
    ["Date Modified", formatTimestamp(photo.date_modified)],
    ["Date Created", formatTimestamp(photo.date_created)],
  ];
}

/** Group key prefix (e.g. "IFD0" from "IFD0:Make"). Keys without a colon go in "Other". */
function extractPrefix(key: string): string {
  const colon = key.indexOf(":");
  return colon > 0 ? key.slice(0, colon) : "Other";
}

export interface MetadataEntry {
  label: string;
  value: string;
  /** Original metadata key (e.g. "IFD0:Make"); used for search, not always shown. */
  fullKey: string;
}

export interface MetadataGroup {
  prefix: string;
  entries: MetadataEntry[];
}

/**
 * Group image metadata entries by their key prefix, preserving a stable order.
 * Returns groups sorted alphabetically by prefix, with "Other" last.
 */
function groupImageMetadata(metadata: Record<string, Variant>): MetadataGroup[] {
  const grouped = new Map<string, MetadataEntry[]>();

  const sortedKeys = Object.keys(metadata).sort((a, b) => a.localeCompare(b));

  for (const key of sortedKeys) {
    const prefix = extractPrefix(key);
    if (!grouped.has(prefix)) grouped.set(prefix, []);
    const label = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
    grouped.get(prefix)!.push({
      label,
      value: formatVariant(metadata[key]),
      fullKey: key,
    });
  }

  const groups: MetadataGroup[] = [];
  const sortedPrefixes = Array.from(grouped.keys()).sort((a, b) => {
    if (a === "Other") return 1;
    if (b === "Other") return -1;
    return a.localeCompare(b);
  });

  for (const prefix of sortedPrefixes) {
    groups.push({ prefix, entries: grouped.get(prefix)! });
  }

  return groups;
}

function detailsRowMatchesSearch(label: string, value: string, fullKey: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(`${label}\n${value}\n${fullKey}`, normalizedQuery);
}

export function DetailsPane({ photo, metadata }: Props) {
  const [detailsSearch, setDetailsSearch] = useState("");
  const normalizedDetailsQuery = useMemo(() => normalizeListSearchQuery(detailsSearch), [detailsSearch]);

  const osEntries = useMemo(() => getOsEntries(photo), [photo]);
  const imageGroups = useMemo(
    () => (metadata !== "loading" ? groupImageMetadata(metadata) : []),
    [metadata],
  );

  const filteredOsEntries = useMemo(() => {
    if (!normalizedDetailsQuery) return osEntries;
    return osEntries.filter(([label, value]) => detailsRowMatchesSearch(label, value, label, normalizedDetailsQuery));
  }, [osEntries, normalizedDetailsQuery]);

  const filteredImageGroups = useMemo(() => {
    if (!normalizedDetailsQuery) return imageGroups;
    return imageGroups
      .map((g) => ({
        ...g,
        entries: g.entries.filter((e) =>
          detailsRowMatchesSearch(e.label, e.value, e.fullKey, normalizedDetailsQuery),
        ),
      }))
      .filter((g) => g.entries.length > 0);
  }, [imageGroups, normalizedDetailsQuery]);

  return (
    <div className="details-pane" data-testid="details-pane">
      <h2 className="details-pane-title">Properties</h2>

      <div className="details-pane-toolbar">
        <label className="details-search-label" htmlFor="details-search-input">
          Search
        </label>
        <input
          id="details-search-input"
          type="search"
          className="details-search-input"
          data-testid="details-search-input"
          placeholder="Filter keys and values…"
          value={detailsSearch}
          onChange={(e) => setDetailsSearch(e.target.value)}
          aria-label="Search properties"
        />
      </div>

      <div className="details-pane-body">
        {/* OS Metadata */}
        <section className="details-section" data-testid="details-section-os">
          <h3 className="details-section-header">OS Metadata</h3>
          <table className="details-table">
            <tbody>
              {filteredOsEntries.map(([label, value]) => (
                <tr key={label} className="details-row" data-testid="details-row">
                  <td className="details-key">
                    <HighlightedText text={label} searchQuery={detailsSearch} />
                  </td>
                  <td className="details-value">
                    <HighlightedText text={value} searchQuery={detailsSearch} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Image Metadata */}
        {metadata === "loading" ? (
          <section className="details-section" data-testid="details-section-loading">
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-loading">Loading metadata…</div>
          </section>
        ) : imageGroups.length === 0 ? (
          <section className="details-section" data-testid="details-section-empty">
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-empty">No image metadata available</div>
          </section>
        ) : (
          filteredImageGroups.map((group) => (
            <section
              className="details-section"
              key={group.prefix}
              data-testid={`details-section-${group.prefix}`}
            >
              <h3 className="details-section-header">{group.prefix}</h3>
              <table className="details-table">
                <tbody>
                  {group.entries.map((entry) => (
                    <tr key={entry.fullKey} className="details-row" data-testid="details-row">
                      <td className="details-key">
                        <HighlightedText text={entry.label} searchQuery={detailsSearch} />
                      </td>
                      <td className="details-value" title={entry.value}>
                        <HighlightedText text={entry.value} searchQuery={detailsSearch} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

// Export for unit testing
export { groupImageMetadata, formatVariant, formatTimestamp, getOsEntries, extractPrefix };

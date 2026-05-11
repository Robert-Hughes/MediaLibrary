import { useMemo, useState } from "react";
import type { PhotoInfo, ImageMetadataState, Variant } from "../types";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { ValueEditDialog } from "./ValueEditDialog";
import { haystackContainsNormalized, normalizeListSearchQuery } from "../utils/listSearchText";

interface Props {
  photo: PhotoInfo;
  metadata: ImageMetadataState;
  draftEdits?: Record<string, string | null>;
  onSetDraft?: (key: string, value: string | null) => void;
  onDiscardDraft?: (key: string) => void;
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
function getOsEntries(photo: PhotoInfo): Array<[string, string, string]> {
  return [
    ["Filename", photo.filename, "filename"],
    ["Relative Path", photo.relative_path, "relative_path"],
    ["Date Modified", formatTimestamp(photo.date_modified), "date_modified"],
    ["Date Created", formatTimestamp(photo.date_created), "date_created"],
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

function detailsRowMatchesSearch(label: string, value: string, draftValue: string | null | undefined, fullKey: string, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(`${label}\n${value}\n${draftValue ?? ""}\n${fullKey}`, normalizedQuery);
}

function DetailsValueCell({ 
  valueKey, 
  originalValue, 
  draftValue, 
  searchQuery, 
  onContextMenu,
  editable = true
}: { 
  valueKey: string, 
  originalValue: string, 
  draftValue?: string | null, 
  searchQuery: string, 
  onContextMenu: (e: React.MouseEvent, key: string, original: string, draft?: string | null) => void,
  editable?: boolean
}) {
  return (
    <td 
      className="details-value" 
      title={originalValue} 
      onContextMenu={editable ? (e) => onContextMenu(e, valueKey, originalValue, draftValue) : undefined}
    >
      {draftValue !== undefined ? (
        <>
          <s className="draft-original" style={{ opacity: 0.6 }}><HighlightedText text={originalValue} searchQuery={searchQuery} /></s>{" "}
          <strong className="draft-new">
            <HighlightedText text={draftValue === null ? "—" : draftValue} searchQuery={searchQuery} />
          </strong>
        </>
      ) : (
        <HighlightedText text={originalValue} searchQuery={searchQuery} />
      )}
    </td>
  );
}

export function DetailsPane({ photo, metadata, draftEdits = {}, onSetDraft, onDiscardDraft }: Props) {
  const [detailsSearch, setDetailsSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, key: string, originalValue: string, draftValue?: string | null } | null>(null);
  const [editDialog, setEditDialog] = useState<{ key: string, initialValue: string } | null>(null);

  const handleContextMenu = (e: React.MouseEvent, key: string, originalValue: string, draftValue?: string | null) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, key, originalValue, draftValue });
  };
  const normalizedDetailsQuery = useMemo(() => normalizeListSearchQuery(detailsSearch), [detailsSearch]);

  const osEntries = useMemo(() => getOsEntries(photo), [photo]);
  const imageGroups = useMemo(
    () => (metadata !== "loading" ? groupImageMetadata(metadata) : []),
    [metadata],
  );

  const filteredOsEntries = useMemo(() => {
    let query = normalizedDetailsQuery;
    const hasEditsFilter = query.includes("has:edits");
    if (hasEditsFilter) {
      query = query.replace("has:edits", "").trim();
    }
    if (!query && !hasEditsFilter) return osEntries;
    return osEntries.filter(([label, value, key]) => {
      if (hasEditsFilter && draftEdits[key] === undefined) return false;
      return detailsRowMatchesSearch(label, value, draftEdits[key], key, query);
    });
  }, [osEntries, normalizedDetailsQuery, draftEdits]);

  const filteredImageGroups = useMemo(() => {
    let query = normalizedDetailsQuery;
    const hasEditsFilter = query.includes("has:edits");
    if (hasEditsFilter) {
      query = query.replace("has:edits", "").trim();
    }
    if (!query && !hasEditsFilter) return imageGroups;
    return imageGroups
      .map((g) => ({
        ...g,
        entries: g.entries.filter((e) => {
          if (hasEditsFilter && draftEdits[e.fullKey] === undefined) return false;
          return detailsRowMatchesSearch(e.label, e.value, draftEdits[e.fullKey], e.fullKey, query);
        }),
      }))
      .filter((g) => g.entries.length > 0);
  }, [imageGroups, normalizedDetailsQuery, draftEdits]);

  const showOsSection = !normalizedDetailsQuery || filteredOsEntries.length > 0;

  return (
    <div className="details-pane" data-testid="details-pane">
      <h2 className="details-pane-title" style={{ display: "flex", alignItems: "center" }}>
        Properties
        {Object.keys(draftEdits).length > 0 && (
          <span 
            className="row-draft-badge" 
            style={{ marginLeft: "auto", cursor: "pointer" }}
            onClick={() => setDetailsSearch("has:edits")}
            title="Show only edited fields"
          >
            {Object.keys(draftEdits).length} edit{Object.keys(draftEdits).length === 1 ? "" : "s"}
          </span>
        )}
      </h2>

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
        {showOsSection && (
          <section className="details-section" data-testid="details-section-os">
            <h3 className="details-section-header">OS Metadata</h3>
            <table className="details-table">
              <tbody>
                {filteredOsEntries.map(([label, value, propKey]) => (
                  <tr key={label} className="details-row" data-testid="details-row">
                    <td className="details-key">
                      <HighlightedText text={label} searchQuery={detailsSearch} />
                    </td>
                    <DetailsValueCell
                      valueKey={propKey}
                      originalValue={value}
                      draftValue={draftEdits[propKey]}
                      searchQuery={detailsSearch}
                      onContextMenu={handleContextMenu}
                      editable={false}
                    />
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

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
                      <DetailsValueCell
                        valueKey={entry.fullKey}
                        originalValue={entry.value}
                        draftValue={draftEdits[entry.fullKey]}
                        searchQuery={detailsSearch}
                        onContextMenu={handleContextMenu}
                      />
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          options={[
            {
              label: "Edit",
              onClick: () => {
                setEditDialog({
                  key: contextMenu.key,
                  initialValue: contextMenu.draftValue !== undefined && contextMenu.draftValue !== null
                    ? contextMenu.draftValue
                    : contextMenu.originalValue,
                });
                setContextMenu(null);
              },
            },
            ...(contextMenu.draftValue !== undefined
              ? [{ label: "Discard", onClick: () => { onDiscardDraft?.(contextMenu.key); setContextMenu(null); } }]
              : []),
            {
              label: "Remove",
              onClick: () => { onSetDraft?.(contextMenu.key, null); setContextMenu(null); },
            },
          ]}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editDialog && (
        <ValueEditDialog
          propertyKey={editDialog.key}
          initialValue={editDialog.initialValue}
          onSave={(newValue) => {
            onSetDraft?.(editDialog.key, newValue);
            setEditDialog(null);
          }}
          onCancel={() => setEditDialog(null)}
        />
      )}
    </div>
  );
}

// Export for unit testing
export { groupImageMetadata, formatVariant, formatTimestamp, getOsEntries, extractPrefix };

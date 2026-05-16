import { useMemo, useState } from "react";
import type { DraftEdit, PhotoInfo, ImageMetadataState, Variant } from "../types";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { TypedValueEditor } from "./editors/TypedValueEditor";
import { useTagInfo } from "../hooks/useTagInfo";
import { READ_ONLY_REMOVE_TOOLTIP } from "./editors/readOnlyMessages";
import { variantToDisplayString } from "../draft";
import { DatatypeBadge } from "./DatatypeBadge";
import { schemaDatatype, variantDatatype, datatypesMatch } from "../utils/datatype";

/**
 * Format a Variant for display.  Single source of truth for the legacy
 * comma-joined / key:value-joined rendering — re-exported as
 * `formatVariant` below so existing tests and call sites keep working
 * during the gradual migration to typed display components.
 */
const formatVariantImpl = variantToDisplayString;
import { NewPropertyDialog } from "./NewPropertyDialog";
import { haystackContainsNormalized, normalizeListSearchQuery } from "../utils/listSearchText";
import { ask } from "@tauri-apps/plugin-dialog";

interface Props {
  photo: PhotoInfo;
  metadata: ImageMetadataState;
  draftEdits?: Record<string, string | null>;
  /**
   * Typed view of the same drafts (key → DraftEdit). Required so the
   * draft-value datatype badge can inspect the underlying Variant; the
   * legacy string map flattens that shape.
   */
  typedDraftEdits?: Record<string, DraftEdit>;
  /** Typed setter used by every editor (Phase 4+). */
  onSetDraftTyped?: (key: string, edit: DraftEdit) => void;
  /** Batch setter for paired-tag editors (GPS). */
  onSetDraftBatch?: (edits: Array<{ key: string; edit: DraftEdit }>) => void;
  onDiscardDraft?: (key: string) => void;
  onDiscardAllEdits?: () => void;
  onApplyEdits?: () => void;
  /**
   * Trigger the AI-description flow for this photo. Wired by App so the
   * progress dialog can live at the app level rather than per-pane.
   * Optional so DetailsPane keeps rendering when the parent doesn't wire
   * the feature (e.g. read-only contexts, older tests).
   */
  onGenerateAiDescription?: () => void;
  /**
   * Reveal this photo in the host file manager. Same backend pathway as
   * the list-view context menu's "Show in File Explorer" entry — the
   * App-level callback owns the index/path lookup so DetailsPane stays
   * agnostic about how the photo is addressed.
   */
  onShowInFileExplorer?: () => void;
}

/** Format an OS timestamp (seconds since epoch, from Rust) into a readable string. */
function formatTimestamp(ts: number | null): string {
  if (ts == null) return "—";
  return new Date(ts * 1000).toLocaleString();
}

/**
 * Recursively format a Variant value for display.  Re-exports
 * `variantToDisplayString` from draft.ts as the single source of truth.
 *
 * Edit-dialog seed values must NOT be derived from this string output,
 * since that was the source of the keywords-as-CSV corruption bug.
 * The raw `Variant` is the source of truth for editing.
 */
const formatVariant = formatVariantImpl;

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
  originalValue,
  draftValue,
  searchQuery,
  valueBadge,
  draftBadge,
  readOnly,
}: {
  originalValue: string,
  draftValue?: string | null,
  searchQuery: string,
  valueBadge?: { code: string; label: string } | null,
  draftBadge?: { code: string; label: string } | null,
  readOnly?: boolean,
}) {
  return (
    <td
      className={readOnly ? "details-value details-value--readonly" : "details-value"}
      title={readOnly ? `${originalValue}\n(read-only)` : originalValue}
      data-readonly={readOnly ? "true" : undefined}
    >
      {draftValue !== undefined ? (
        <>
          {originalValue ? (
            <>
              {valueBadge ? <DatatypeBadge code={valueBadge.code} label={valueBadge.label} variant="value" /> : null}
              <s className="draft-original" style={{ opacity: 0.6 }}><HighlightedText text={originalValue} searchQuery={searchQuery} /></s>
              {" "}
            </>
          ) : null}
          {draftBadge ? <DatatypeBadge code={draftBadge.code} label={draftBadge.label} variant="draft" /> : null}
          <strong className="draft-new">
            <HighlightedText text={draftValue === null ? "—" : draftValue} searchQuery={searchQuery} />
          </strong>
        </>
      ) : (
        <>
          {valueBadge ? <DatatypeBadge code={valueBadge.code} label={valueBadge.label} variant="value" /> : null}
          <HighlightedText text={originalValue} searchQuery={searchQuery} />
        </>
      )}
    </td>
  );
}

/**
 * One image-metadata row. Owns its `useTagInfo` lookup so each row can
 * independently render schema/value/draft datatype badges. Lifted out of
 * `DetailsPane` because hooks can't run inside `.map()` callbacks.
 */
function DetailsImageRow({
  entry,
  rawValue,
  draftValue,
  typedDraft,
  searchQuery,
  onContextMenu,
}: {
  entry: MetadataEntry;
  rawValue: Variant | undefined;
  draftValue: string | null | undefined;
  typedDraft: DraftEdit | undefined;
  searchQuery: string;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const tag = useTagInfo(entry.fullKey);
  const schemaInfo = tag && tag !== "loading" ? schemaDatatype(tag.kind) : null;
  const readOnly = tag != null && tag !== "loading" && !tag.writable;

  const valueInfo = variantDatatype(rawValue);
  // With a schema, the value badge is a divergence indicator (hidden when
  // the type matches expectations). Without a schema there is no reference
  // type, so always surface the runtime datatype as informational.
  const showValueBadge =
    valueInfo != null
    && (schemaInfo == null || !datatypesMatch(valueInfo.code, schemaInfo.code));

  const draftVariant = typedDraft && typedDraft.intent !== "Delete" ? typedDraft.value : undefined;
  const draftInfo = variantDatatype(draftVariant ?? undefined);
  const showDraftBadge =
    typedDraft != null
    && typedDraft.intent !== "Delete"
    && draftInfo != null
    && (
      (valueInfo != null && draftInfo.code !== valueInfo.code)
      || (schemaInfo != null && !datatypesMatch(draftInfo.code, schemaInfo.code))
      || (schemaInfo == null && valueInfo == null)
    );

  return (
    <tr
      key={entry.fullKey}
      className="details-row"
      data-testid="details-row"
      data-row-key={entry.fullKey}
      onContextMenu={onContextMenu}
    >
      <td className="details-key" style={draftValue !== undefined ? { color: "var(--accent-draft)" } : undefined}>
        {schemaInfo ? <DatatypeBadge code={schemaInfo.code} label={schemaInfo.label} variant="schema" /> : null}
        <HighlightedText text={entry.label} searchQuery={searchQuery} />
      </td>
      <DetailsValueCell
        originalValue={entry.value}
        draftValue={draftValue}
        searchQuery={searchQuery}
        valueBadge={showValueBadge ? valueInfo : null}
        draftBadge={showDraftBadge ? draftInfo : null}
        readOnly={readOnly}
      />
    </tr>
  );
}

/**
 * Right-click menu for a property row. Lives in its own component so it can
 * call `useTagInfo(contextMenu.key)` — schema lookup decides whether to
 * relabel "Edit" → "View" and whether "Remove" should be blocked. Read-only
 * tags can be viewed (the Save button inside the dialog stays disabled) but
 * not removed from the file, since ExifTool refuses delete-writes on
 * read-only tags just like it refuses value-writes.
 */
function DetailsRowContextMenu({
  contextMenu,
  existsInOriginal,
  onEdit,
  onDiscard,
  onRemove,
  onClose,
}: {
  contextMenu: { x: number; y: number; key: string; originalValue: string; draftValue?: string | null };
  existsInOriginal: boolean;
  onEdit: () => void;
  onDiscard: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const tag = useTagInfo(contextMenu.key);
  const readOnly = tag !== null && tag !== "loading" && !tag.writable;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      options={[
        {
          label: readOnly ? "View" : "Edit",
          onClick: onEdit,
        },
        ...(contextMenu.draftValue !== undefined
          ? [{ label: "Discard edit", onClick: onDiscard }]
          : []),
        {
          label: "Remove",
          onClick: onRemove,
          disabled: readOnly && existsInOriginal,
          title: readOnly && existsInOriginal ? READ_ONLY_REMOVE_TOOLTIP : undefined,
        },
      ]}
      onClose={onClose}
    />
  );
}

export function DetailsPane({ photo, metadata, draftEdits = {}, typedDraftEdits, onSetDraftTyped, onSetDraftBatch, onDiscardDraft, onDiscardAllEdits, onApplyEdits, onGenerateAiDescription, onShowInFileExplorer }: Props) {
  const [detailsSearch, setDetailsSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, key: string, originalValue: string, draftValue?: string | null } | null>(null);
  const [editDialog, setEditDialog] = useState<{ key: string, initialValue: string } | null>(null);
  const [showNewPropertyDialog, setShowNewPropertyDialog] = useState(false);
  // Stage 2 of the new-property flow: key picked, now show a TypedValueEditor
  // for that key.  null when no flow is active or we're still on stage 1.
  const [newPropertyKey, setNewPropertyKey] = useState<string | null>(null);

  const handleContextMenu = (e: React.MouseEvent, key: string, originalValue: string, draftValue?: string | null) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, key, originalValue, draftValue });
  };
  const normalizedDetailsQuery = useMemo(() => normalizeListSearchQuery(detailsSearch), [detailsSearch]);

  const osEntries = useMemo(() => getOsEntries(photo), [photo]);
  const imageGroups = useMemo(() => {
    if (metadata === "loading") return [];
    
    const combinedMetadata: Record<string, Variant> = { ...metadata };
    if (draftEdits) {
      for (const [key, value] of Object.entries(draftEdits)) {
        if (value !== null && !(key in combinedMetadata)) {
          combinedMetadata[key] = "";
        }
      }
    }
    return groupImageMetadata(combinedMetadata);
  }, [metadata, draftEdits]);

  const existingMetadataKeys = useMemo(() => {
    const keys = new Set<string>();
    if (metadata !== "loading") {
      for (const k of Object.keys(metadata)) keys.add(k);
    }
    if (draftEdits) {
      for (const [k, v] of Object.entries(draftEdits)) {
        if (v !== null) keys.add(k);
      }
    }
    return keys;
  }, [metadata, draftEdits]);

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
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "6px" }}>
            <span 
              className="row-draft-badge" 
              style={{ cursor: "pointer", marginLeft: 0 }}
              onClick={() => setDetailsSearch("has:edits")}
              title="Show only edited fields"
            >
              {Object.keys(draftEdits).length} edit{Object.keys(draftEdits).length === 1 ? "" : "s"}
            </span>
            {onApplyEdits && (
              <button
                className="button button--primary"
                style={{ padding: "2px 6px", fontSize: "11px", minHeight: "auto", borderRadius: "8px" }}
                onClick={async () => {
                  const numEdits = Object.keys(draftEdits).length;
                  const confirmed = await ask(
                    `Apply ${numEdits} edit${numEdits === 1 ? "" : "s"} to this photo?\n\nThis will permanently modify the original image file. There is no backup.`,
                    { title: "Apply Edits", kind: "warning" }
                  );
                  if (confirmed) onApplyEdits();
                }}
                data-testid="details-pane-apply-btn"
                title="Apply draft edits to the original image file"
              >
                Apply
              </button>
            )}
            <button
              className="button button--secondary"
              style={{ padding: "2px 6px", fontSize: "11px", minHeight: "auto", borderRadius: "8px" }}
              onClick={async () => {
                if (!onDiscardAllEdits) return;
                const numEdits = Object.keys(draftEdits).length;
                const confirmed = await ask(`Are you sure you want to discard ${numEdits} edit${numEdits === 1 ? "" : "s"} for this photo?`, { title: "Discard all edits", kind: "warning" });
                if (confirmed) onDiscardAllEdits();
              }}
              title="Discard all edits for this photo"
            >
              Discard all edits
            </button>
          </div>
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
                    <td className="details-key" style={draftEdits[propKey] !== undefined ? { color: "var(--accent-draft)" } : undefined}>
                      <HighlightedText text={label} searchQuery={detailsSearch} />
                    </td>
                    <DetailsValueCell
                      originalValue={value}
                      draftValue={draftEdits[propKey]}
                      searchQuery={detailsSearch}
                      readOnly
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
        ) : (
          <>
            {filteredImageGroups.length === 0 ? (
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
                        <DetailsImageRow
                          key={entry.fullKey}
                          entry={entry}
                          rawValue={typeof metadata === "object" ? (metadata as Record<string, Variant>)[entry.fullKey] : undefined}
                          draftValue={draftEdits[entry.fullKey]}
                          typedDraft={typedDraftEdits?.[entry.fullKey]}
                          searchQuery={detailsSearch}
                          onContextMenu={(e) => handleContextMenu(e, entry.fullKey, entry.value, draftEdits[entry.fullKey])}
                        />
                      ))}
                    </tbody>
                  </table>
                </section>
              ))
            )}
          </>
        )}
      </div>

      {metadata !== "loading" && (
        <div className="details-pane-footer" data-testid="details-pane-footer">
          <button
            className="button button--secondary"
            onClick={() => setShowNewPropertyDialog(true)}
          >
            + Add Property
          </button>
          {onShowInFileExplorer && (
            <button
              className="button button--secondary"
              data-testid="details-pane-show-in-explorer-btn"
              title="Reveal this image in the host file manager"
              onClick={() => onShowInFileExplorer()}
            >
              Show in File Explorer
            </button>
          )}
          {onGenerateAiDescription && (
            <button
              className="button button--secondary"
              data-testid="details-pane-generate-ai-btn"
              title="Generate an AI description for this image via OpenAI"
              onClick={async () => {
                const inMeta = typeof metadata === "object"
                  && metadata !== null
                  && "XMP-mlib:AIDescription" in (metadata as Record<string, Variant>);
                // Prefer the typed draft store when wired through — it's the
                // source of truth and survives the legacy-map round-trip
                // dropping files with empty edits.
                const inDraft = typedDraftEdits
                  ? "XMP-mlib:AIDescription" in typedDraftEdits
                  : "XMP-mlib:AIDescription" in draftEdits;
                if (inMeta || inDraft) {
                  const confirmed = await ask(
                    "This image already has an AI description. Generating a new one will overwrite the existing one. Continue?",
                    { title: "Overwrite AI description?", kind: "warning" }
                  );
                  if (!confirmed) return;
                }
                onGenerateAiDescription();
              }}
            >
              Generate AI Description
            </button>
          )}
        </div>
      )}

      {contextMenu && (
        <DetailsRowContextMenu
          contextMenu={contextMenu}
          existsInOriginal={
            metadata !== "loading" && contextMenu.key in (metadata as Record<string, Variant>)
          }
          onEdit={() => {
            setEditDialog({
              key: contextMenu.key,
              initialValue: contextMenu.draftValue !== undefined && contextMenu.draftValue !== null
                ? contextMenu.draftValue
                : contextMenu.originalValue,
            });
            setContextMenu(null);
          }}
          onDiscard={() => { onDiscardDraft?.(contextMenu.key); setContextMenu(null); }}
          onRemove={() => {
            const existsInOriginal =
              metadata !== "loading" && contextMenu.key in (metadata as Record<string, Variant>);
            if (existsInOriginal) {
              onSetDraftTyped?.(contextMenu.key, { value: null, intent: "Delete" });
            } else {
              onDiscardDraft?.(contextMenu.key);
            }
            setContextMenu(null);
          }}
          onClose={() => setContextMenu(null)}
        />
      )}

      {editDialog && (
        <TypedValueEditor
          propertyKey={editDialog.key}
          initialVariant={(() => {
            // Prefer the typed draft Variant when one is already pending —
            // otherwise an editor that consults the raw value (notably
            // EnumEditor) would silently revert to the on-disk metadata
            // every time the row was re-edited.
            const pending = typedDraftEdits?.[editDialog.key];
            if (pending && pending.intent !== "Delete") return pending.value;
            return metadata !== "loading" ? (metadata[editDialog.key] as Variant | undefined) : undefined;
          })()}
          metadataForFile={metadata !== "loading" ? (metadata as Record<string, Variant>) : undefined}
          initialString={editDialog.initialValue}
          onSaveBatch={onSetDraftBatch ? (edits) => { onSetDraftBatch(edits); setEditDialog(null); } : undefined}
          onSave={(edit) => {
            onSetDraftTyped?.(editDialog.key, edit);
            setEditDialog(null);
          }}
          onCancel={() => setEditDialog(null)}
        />
      )}

      {showNewPropertyDialog && (
        <NewPropertyDialog
          onSave={(key) => {
            setShowNewPropertyDialog(false);
            setNewPropertyKey(key);
          }}
          onCancel={() => setShowNewPropertyDialog(false)}
          existingKeys={existingMetadataKeys}
          filename={photo.filename}
        />
      )}

      {newPropertyKey !== null && (
        <TypedValueEditor
          propertyKey={newPropertyKey}
          initialVariant={undefined}
          initialString=""
          metadataForFile={metadata !== "loading" ? (metadata as Record<string, Variant>) : undefined}
          onSaveBatch={onSetDraftBatch ? (edits) => { onSetDraftBatch(edits); setNewPropertyKey(null); } : undefined}
          onSave={(edit) => {
            onSetDraftTyped?.(newPropertyKey, edit);
            setNewPropertyKey(null);
          }}
          onCancel={() => setNewPropertyKey(null)}
        />
      )}
    </div>
  );
}

// Export for unit testing
export { groupImageMetadata, formatVariant, formatTimestamp, getOsEntries, extractPrefix };

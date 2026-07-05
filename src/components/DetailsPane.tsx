import { useEffect, useMemo, useState } from "react";
import type {
  ImageMetadataEntry,
  MetadataDraftEdit,
  MetadataValue,
  PhotoInfo,
  ImageMetadataState,
} from "../types";
import { HighlightedText } from "./HighlightedText";
import { ContextMenu } from "./ContextMenu";
import { TypedValueEditor } from "./editors/TypedValueEditor";
import { useTagInfo } from "../hooks/useTagInfo";
import { DatatypeBadge } from "./DatatypeBadge";
import {
  schemaDatatype,
  variantDatatype,
  metadataValueDatatype,
  datatypesMatch,
} from "../utils/datatype";
import { NewPropertyDialog } from "./NewPropertyDialog";
import type { MetadataEntry } from "../utils/detailsPaneHelpers";
import { groupImageMetadata, getOsEntries } from "../utils/detailsPaneHelpers";
import {
  haystackContainsNormalized,
  normalizeListSearchQuery,
} from "../utils/listSearchText";
import {
  confirmApplyEdits,
  confirmDiscardEdits,
} from "../utils/applyDiscardPrompts";
import { displayStringOfMetadataDraft } from "../draft";

interface Props {
  photo: PhotoInfo;
  metadata: ImageMetadataState;
  draftEdits?: Record<string, string | null>;
  /** Semantic view of the same drafts. */
  typedDraftEdits?: Record<string, MetadataDraftEdit>;
  /** Semantic setter used by every editor via the local adapter. */
  onSetMetadataDraft?: (key: string, edit: MetadataDraftEdit) => void;
  /** Batch setter for paired-tag editors (GPS). */
  onSetMetadataDraftBatch?: (
    edits: Array<{ key: string; edit: MetadataDraftEdit }>,
  ) => void;
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
   * Trigger the reverse-geocoding flow for this image. App-level
   * callback so the geocode progress dialog lives once, not once per
   * pane. Optional so DetailsPane keeps rendering when the parent
   * doesn't wire the feature (e.g. tests, read-only contexts).
   */
  onGeocode?: () => void;
  /**
   * Trigger the metadata-normalisation flow for this image. App-level
   * callback so the normalise progress dialog lives once, not once per
   * pane. Optional so DetailsPane keeps rendering in tests / read-only
   * contexts that don't wire the feature.
   */
  onNormalise?: () => void;
  /**
   * Reveal this photo in the host file manager. Same backend pathway as
   * the list-view context menu's "Show in File Explorer" entry — the
   * App-level callback owns the index/path lookup so DetailsPane stays
   * agnostic about how the photo is addressed.
   */
  onShowInFileExplorer?: () => void;
}

function detailsRowMatchesSearch(
  label: string,
  value: string,
  draftValue: string | null | undefined,
  fullKey: string,
  normalizedQuery: string,
): boolean {
  if (!normalizedQuery) return true;
  return haystackContainsNormalized(
    `${label}\n${value}\n${draftValue ?? ""}\n${fullKey}`,
    normalizedQuery,
  );
}

/**
 * Split a normalized details-search query into the residual text query
 * and a `has:edits` boolean filter. Returns the bare query (with the
 * `has:edits` token stripped + trimmed) so the standard substring match
 * runs against the user's actual search terms.
 */
function splitHasEditsFilter(normalizedQuery: string): {
  query: string;
  hasEditsFilter: boolean;
} {
  const hasEditsFilter = normalizedQuery.includes("has:edits");
  const query = hasEditsFilter
    ? normalizedQuery.replace("has:edits", "").trim()
    : normalizedQuery;
  return { query, hasEditsFilter };
}

function displayStringOfDraft(
  edit: MetadataDraftEdit | undefined,
): string | null | undefined {
  if (edit === undefined) return undefined;
  return displayStringOfMetadataDraft(edit);
}

function DetailsValueCell({
  originalValue,
  draftValue,
  searchQuery,
  valueBadge,
  draftBadge,
  readOnly,
}: {
  originalValue: string;
  draftValue?: string | null;
  searchQuery: string;
  valueBadge?: { code: string; label: string } | null;
  draftBadge?: { code: string; label: string } | null;
  readOnly?: boolean;
}) {
  return (
    <td
      className={
        readOnly ? "details-value details-value--readonly" : "details-value"
      }
      title={readOnly ? `${originalValue}\n(read-only)` : originalValue}
      data-readonly={readOnly ? "true" : undefined}
    >
      {draftValue !== undefined ? (
        <>
          {originalValue ? (
            <>
              {valueBadge ? (
                <DatatypeBadge
                  code={valueBadge.code}
                  label={valueBadge.label}
                  variant="value"
                />
              ) : null}
              <s className="draft-original" style={{ opacity: 0.6 }}>
                <HighlightedText
                  text={originalValue}
                  searchQuery={searchQuery}
                />
              </s>{" "}
            </>
          ) : null}
          {draftBadge ? (
            <DatatypeBadge
              code={draftBadge.code}
              label={draftBadge.label}
              variant="draft"
            />
          ) : null}
          <strong className="draft-new">
            <HighlightedText
              text={draftValue === null ? "—" : draftValue}
              searchQuery={searchQuery}
            />
          </strong>
        </>
      ) : (
        <>
          {valueBadge ? (
            <DatatypeBadge
              code={valueBadge.code}
              label={valueBadge.label}
              variant="value"
            />
          ) : null}
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
  rawValue: ImageMetadataEntry | undefined;
  draftValue: string | null | undefined;
  typedDraft: MetadataDraftEdit | undefined;
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
    valueInfo != null &&
    (schemaInfo == null || !datatypesMatch(valueInfo.code, schemaInfo.code));

  const draftInfo =
    typedDraft && typedDraft.intent !== "Delete"
      ? metadataValueDatatype(typedDraft.value ?? undefined)
      : null;
  const showDraftBadge =
    typedDraft != null &&
    typedDraft.intent !== "Delete" &&
    draftInfo != null &&
    ((valueInfo != null && draftInfo.code !== valueInfo.code) ||
      (schemaInfo != null &&
        !datatypesMatch(draftInfo.code, schemaInfo.code)) ||
      (schemaInfo == null && valueInfo == null));

  return (
    <tr
      key={entry.fullKey}
      className={readOnly ? "details-row details-row--readonly" : "details-row"}
      data-testid="details-row"
      data-row-key={entry.fullKey}
      data-readonly={readOnly ? "true" : undefined}
      onContextMenu={onContextMenu}
    >
      <td
        className="details-key"
        style={
          draftValue !== undefined
            ? { color: "var(--accent-draft)" }
            : undefined
        }
      >
        {schemaInfo ? (
          <DatatypeBadge
            code={schemaInfo.code}
            label={schemaInfo.label}
            variant="schema"
          />
        ) : null}
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
 * hide the "Edit…" entry and whether "Remove" should be blocked. Read-only
 * tags expose no editor entry point from the context menu, and cannot be
 * removed since ExifTool refuses delete-writes on read-only tags just like
 * it refuses value-writes.
 */
function DetailsRowContextMenu({
  contextMenu,
  onEdit,
  onDiscard,
  onRemove,
  onClose,
}: {
  contextMenu: {
    x: number;
    y: number;
    key: string;
    originalValue: string;
    draftValue?: string | null;
  };
  onEdit: () => void;
  onDiscard: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const tag = useTagInfo(contextMenu.key);
  const readOnly = tag !== null && tag !== "loading" && !tag.writable;
  const options = [
    ...(readOnly ? [] : [{ label: "Edit…", onClick: onEdit }]),
    ...(contextMenu.draftValue !== undefined
      ? [{ label: "Discard edit", onClick: onDiscard }]
      : []),
    ...(readOnly
      ? []
      : [
          {
            label: "Remove",
            onClick: onRemove,
            disabled: false,
            title: undefined as string | undefined,
          },
        ]),
  ];
  // Read-only tag with no draft → no actionable menu items. Bail out via
  // effect (not inline) so we don't setState during render.
  const empty = options.length === 0;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  if (empty) return null;
  return (
    <ContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      options={options}
      onClose={onClose}
    />
  );
}

export function DetailsPane({
  photo,
  metadata,
  draftEdits: legacyDraftEdits,
  typedDraftEdits,
  onSetMetadataDraft,
  onSetMetadataDraftBatch,
  onDiscardDraft,
  onDiscardAllEdits,
  onApplyEdits,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onShowInFileExplorer,
}: Props) {
  const [detailsSearch, setDetailsSearch] = useState("");
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    key: string;
    originalValue: string;
    draftValue?: string | null;
  } | null>(null);
  const [editDialog, setEditDialog] = useState<{
    key: string;
    initialValue: string;
  } | null>(null);
  const [showNewPropertyDialog, setShowNewPropertyDialog] = useState(false);
  // Stage 2 of the new-property flow: key picked, now show a TypedValueEditor
  // for that key.  null when no flow is active or we're still on stage 1.
  const [newPropertyKey, setNewPropertyKey] = useState<string | null>(null);

  const draftEdits = useMemo(() => {
    if (legacyDraftEdits) return legacyDraftEdits;
    if (!typedDraftEdits) return {};
    return Object.fromEntries(
      Object.entries(typedDraftEdits)
        .map(([key, edit]) => [key, displayStringOfDraft(edit)] as const)
        .filter(
          (entry): entry is readonly [string, string | null] =>
            entry[1] !== undefined,
        ),
    );
  }, [legacyDraftEdits, typedDraftEdits]);

  const handleContextMenu = (
    e: React.MouseEvent,
    key: string,
    originalValue: string,
    draftValue?: string | null,
  ) => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      key,
      originalValue,
      draftValue,
    });
  };
  const normalizedDetailsQuery = useMemo(
    () => normalizeListSearchQuery(detailsSearch),
    [detailsSearch],
  );

  const osEntries = useMemo(() => getOsEntries(photo), [photo]);
  const imageGroups = useMemo(() => {
    if (metadata === "loading") return [];

    const combinedMetadata: Record<string, ImageMetadataEntry> = {
      ...metadata,
    };
    if (draftEdits) {
      for (const [key, value] of Object.entries(draftEdits)) {
        if (value !== null && !(key in combinedMetadata)) {
          combinedMetadata[key] = { kind: "Null" };
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
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (!query && !hasEditsFilter) return osEntries;
    return osEntries.filter(([label, value, key]) => {
      if (hasEditsFilter && draftEdits[key] === undefined) return false;
      return detailsRowMatchesSearch(label, value, draftEdits[key], key, query);
    });
  }, [osEntries, normalizedDetailsQuery, draftEdits]);

  const filteredImageGroups = useMemo(() => {
    const { query, hasEditsFilter } = splitHasEditsFilter(
      normalizedDetailsQuery,
    );
    if (!query && !hasEditsFilter) return imageGroups;
    return imageGroups
      .map((g) => ({
        ...g,
        entries: g.entries.filter((e) => {
          if (hasEditsFilter && draftEdits[e.fullKey] === undefined)
            return false;
          return detailsRowMatchesSearch(
            e.label,
            e.value,
            draftEdits[e.fullKey],
            e.fullKey,
            query,
          );
        }),
      }))
      .filter((g) => g.entries.length > 0);
  }, [imageGroups, normalizedDetailsQuery, draftEdits]);

  const showOsSection = !normalizedDetailsQuery || filteredOsEntries.length > 0;

  return (
    <div className="details-pane" data-testid="details-pane">
      <h2
        className="details-pane-title"
        style={{ display: "flex", alignItems: "center" }}
      >
        Properties
        {Object.keys(draftEdits).length > 0 && (
          <div
            style={{
              marginLeft: "auto",
              display: "flex",
              alignItems: "center",
              gap: "6px",
            }}
          >
            <span
              className="row-draft-badge"
              style={{ cursor: "pointer", marginLeft: 0 }}
              onClick={() => setDetailsSearch("has:edits")}
              title="Show only edited fields"
            >
              {Object.keys(draftEdits).length} edit
              {Object.keys(draftEdits).length === 1 ? "" : "s"}
            </span>
            {onApplyEdits && (
              <button
                className="button button--primary"
                style={{
                  padding: "2px 6px",
                  fontSize: "11px",
                  minHeight: "auto",
                  borderRadius: "8px",
                }}
                onClick={async () => {
                  const editCount = Object.keys(draftEdits).length;
                  const confirmed = await confirmApplyEdits({
                    editCount,
                    target: "this photo",
                    photoCount: 1,
                  });
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
              style={{
                padding: "2px 6px",
                fontSize: "11px",
                minHeight: "auto",
                borderRadius: "8px",
              }}
              onClick={async () => {
                if (!onDiscardAllEdits) return;
                const editCount = Object.keys(draftEdits).length;
                const confirmed = await confirmDiscardEdits({
                  editCount,
                  scope: "this photo",
                });
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
                  <tr
                    key={label}
                    className="details-row"
                    data-testid="details-row"
                  >
                    <td
                      className="details-key"
                      style={
                        draftEdits[propKey] !== undefined
                          ? { color: "var(--accent-draft)" }
                          : undefined
                      }
                    >
                      <HighlightedText
                        text={label}
                        searchQuery={detailsSearch}
                      />
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
          <section
            className="details-section"
            data-testid="details-section-loading"
          >
            <h3 className="details-section-header">Image Metadata</h3>
            <div className="details-loading">Loading metadata…</div>
          </section>
        ) : (
          <>
            {filteredImageGroups.length === 0 ? (
              <section
                className="details-section"
                data-testid="details-section-empty"
              >
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
                          rawValue={
                            typeof metadata === "object"
                              ? metadata[entry.fullKey]
                              : undefined
                          }
                          draftValue={draftEdits[entry.fullKey]}
                          typedDraft={typedDraftEdits?.[entry.fullKey]}
                          searchQuery={detailsSearch}
                          onContextMenu={(e) =>
                            handleContextMenu(
                              e,
                              entry.fullKey,
                              entry.value,
                              draftEdits[entry.fullKey],
                            )
                          }
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
            + Add Property…
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
              onClick={() => onGenerateAiDescription()}
            >
              Generate AI Description…
            </button>
          )}
          {onGeocode && (
            <button
              className="button button--secondary"
              data-testid="details-pane-geocode-btn"
              title="Reverse-geocode this image's GPS via OpenStreetMap Nominatim"
              onClick={() => onGeocode()}
            >
              Reverse Geocode…
            </button>
          )}
          {onNormalise && (
            <button
              className="button button--secondary"
              data-testid="details-pane-normalise-btn"
              title="Normalise metadata: sync canonical fields across XMP / IPTC / EXIF"
              onClick={() => onNormalise()}
            >
              Normalise Metadata…
            </button>
          )}
        </div>
      )}

      {contextMenu && (
        <DetailsRowContextMenu
          contextMenu={contextMenu}
          onEdit={() => {
            setEditDialog({
              key: contextMenu.key,
              initialValue:
                contextMenu.draftValue !== undefined &&
                contextMenu.draftValue !== null
                  ? contextMenu.draftValue
                  : contextMenu.originalValue,
            });
            setContextMenu(null);
          }}
          onDiscard={() => {
            onDiscardDraft?.(contextMenu.key);
            setContextMenu(null);
          }}
          onRemove={() => {
            const existsInOriginal =
              metadata !== "loading" &&
              contextMenu.key in (metadata as Record<string, MetadataValue>);
            if (existsInOriginal) {
              onSetMetadataDraft?.(contextMenu.key, {
                value: null,
                intent: "Delete",
              });
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
          initialMetadataValue={(() => {
            // Prefer the typed draft MetadataValue when one is already pending —
            // otherwise an editor that consults the raw value (notably
            // EnumEditor) would silently revert to the on-disk metadata
            // every time the row was re-edited.
            const pending = typedDraftEdits?.[editDialog.key];
            if (pending && pending.intent !== "Delete") {
              return pending.value ?? undefined;
            }
            return metadata !== "loading"
              ? (metadata[editDialog.key] as MetadataValue)
              : undefined;
          })()}
          metadataForFile={
            metadata !== "loading"
              ? (metadata as Record<string, MetadataValue>)
              : undefined
          }
          initialString={editDialog.initialValue}
          onSaveMetadataBatch={
            onSetMetadataDraftBatch
              ? (edits) => {
                  onSetMetadataDraftBatch(edits);
                  setEditDialog(null);
                }
              : undefined
          }
          onSaveMetadata={(edit) => {
            onSetMetadataDraft?.(editDialog.key, edit);
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
          initialMetadataValue={undefined}
          initialString=""
          metadataForFile={
            metadata !== "loading"
              ? (metadata as Record<string, MetadataValue>)
              : undefined
          }
          onSaveMetadataBatch={
            onSetMetadataDraftBatch
              ? (edits) => {
                  onSetMetadataDraftBatch(edits);
                  setNewPropertyKey(null);
                }
              : undefined
          }
          onSaveMetadata={(edit) => {
            onSetMetadataDraft?.(newPropertyKey, edit);
            setNewPropertyKey(null);
          }}
          onCancel={() => setNewPropertyKey(null)}
        />
      )}
    </div>
  );
}

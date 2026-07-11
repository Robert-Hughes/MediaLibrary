import { useState } from "react";
import { ModalDialog } from "./ModalDialog";
import { DEFAULT_VISIBLE_COLUMNS, OS_COLUMN_KEYS } from "../utils/columnConfig";
import type { SchemaDefinitionId, VisibleColumn } from "../types";
import { useTagInfos } from "../hooks/useTagInfo";
import {
  schemaDefinitionIdToken,
  tagInfoDisplayName,
} from "../utils/schemaDefinitionId";
import { visibleColumnToken } from "../utils/columnIdentity";

interface Props {
  allKeys: Array<{ id: SchemaDefinitionId; count: number }>;
  visibleColumns: VisibleColumn[];
  onSave: (columns: VisibleColumn[], resetWidths?: boolean) => void;
  onClose: () => void;
}

const OS_OPTIONS = [
  { key: "date_modified", label: "Date Modified" },
  { key: "date_created", label: "Date Created" },
];

/**
 * Build the saved column array from selected sets.
 *
 * Existing entries (still selected) keep their original order so reorders
 * survive a save. Newly checked entries are appended in section order:
 * OS first, then image (matching the default layout).
 */
function mergeSelection(
  existing: VisibleColumn[],
  selectedOS: Set<string>,
  selectedImage: Set<string>,
  imageIds: Map<string, SchemaDefinitionId>,
): VisibleColumn[] {
  const kept = existing.filter((c) =>
    c.kind === "os"
      ? selectedOS.has(c.key)
      : selectedImage.has(schemaDefinitionIdToken(c.id)),
  );
  const keptKeys = new Set(kept.map(visibleColumnToken));
  const additions: VisibleColumn[] = [];
  for (const key of OS_COLUMN_KEYS) {
    if (selectedOS.has(key) && !keptKeys.has(key))
      additions.push({ key, kind: "os" });
  }
  for (const key of selectedImage) {
    const id = imageIds.get(key);
    if (id && !keptKeys.has(key)) additions.push({ id, kind: "image" });
  }
  return [...kept, ...additions];
}

export function ColumnSelectionDialog({
  allKeys,
  visibleColumns,
  onSave,
  onClose,
}: Props) {
  const initialOS = new Set(
    visibleColumns.filter((c) => c.kind === "os").map((c) => c.key),
  );
  const initialImage = new Set(
    visibleColumns
      .filter((c) => c.kind === "image")
      .map((c) => schemaDefinitionIdToken(c.id)),
  );
  const tagInfos = useTagInfos(allKeys.map(({ id }) => id));
  const imageIds = new Map(
    allKeys.map(({ id }) => [schemaDefinitionIdToken(id), id]),
  );
  const [selectedOS, setSelectedOS] = useState<Set<string>>(initialOS);
  const [selected, setSelected] = useState<Set<string>>(initialImage);
  // Order basis for the saved array: usually mirrors the prop, but the
  // "Default" button swaps it to DEFAULT_VISIBLE_COLUMNS so default ordering
  // takes effect even if the user had reordered columns previously.
  const [orderBasis, setOrderBasis] = useState<VisibleColumn[]>(visibleColumns);
  const [searchTerm, setSearchTerm] = useState<string>("");
  const [resetWidths, setResetWidths] = useState(false);

  const toggle = (key: string) => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const toggleOS = (key: string) => {
    const next = new Set(selectedOS);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelectedOS(next);
  };

  const selectAll = () => {
    setSelected(
      new Set(allKeys.map((item) => schemaDefinitionIdToken(item.id))),
    );
    setSelectedOS(new Set(OS_COLUMN_KEYS));
  };

  const deselectAll = () => {
    setSelected(new Set());
    setSelectedOS(new Set());
  };

  const resetToDefaults = () => {
    setSelected(
      new Set(
        DEFAULT_VISIBLE_COLUMNS.filter((c) => c.kind === "image").map((c) =>
          schemaDefinitionIdToken(c.id),
        ),
      ),
    );
    setSelectedOS(
      new Set(
        DEFAULT_VISIBLE_COLUMNS.filter((c) => c.kind === "os").map(
          (c) => c.key,
        ),
      ),
    );
    setOrderBasis(DEFAULT_VISIBLE_COLUMNS);
    setResetWidths(true);
  };

  const itemLabel = ({ id }: { id: SchemaDefinitionId }) => {
    const info = tagInfos[schemaDefinitionIdToken(id)];
    return info && info !== "loading"
      ? tagInfoDisplayName(info)
      : `${id.table} / ${id.tag_id}`;
  };
  const sortedKeys = [...allKeys].sort((a, b) =>
    itemLabel(a).localeCompare(itemLabel(b)),
  );

  const lowerSearch = searchTerm.toLowerCase();

  const filteredKeys = sortedKeys.filter(
    (item) =>
      itemLabel(item).toLowerCase().includes(lowerSearch) ||
      item.id.table.toLowerCase().includes(lowerSearch) ||
      item.id.tag_id.toLowerCase().includes(lowerSearch),
  );

  const filteredOSColumns = OS_OPTIONS.filter(
    ({ key, label }) =>
      key.toLowerCase().includes(lowerSearch) ||
      label.toLowerCase().includes(lowerSearch),
  );

  return (
    <ModalDialog
      open
      onDismiss={onClose}
      testId="column-dialog-overlay"
      aria-label="Select columns"
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSave(
            mergeSelection(orderBasis, selectedOS, selected, imageIds),
            resetWidths,
          );
        }
      }}
    >
      <div className="dialog-content column-dialog" data-testid="column-dialog">
        <div className="dialog-header">
          <h2 className="dialog-title">Select Columns</h2>
          <button className="dialog-close-btn" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="dialog-body column-list-area">
          <p className="dialog-hint">
            Choose which columns to display in the photo list.
          </p>

          <div className="column-actions">
            <button className="btn-secondary btn-small" onClick={selectAll}>
              Select All
            </button>
            <button className="btn-secondary btn-small" onClick={deselectAll}>
              Deselect All
            </button>
            <button
              className="btn-secondary btn-small"
              onClick={resetToDefaults}
            >
              Default
            </button>
          </div>

          <div className="column-search">
            <input
              type="text"
              placeholder="Search columns..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="column-search-input"
            />
          </div>

          {filteredOSColumns.length > 0 && (
            <div className="column-section">
              <h3 className="column-section-title">OS Metadata</h3>
              <div className="column-list">
                {filteredOSColumns.map(({ key, label }) => (
                  <label key={key} className="column-item">
                    <input
                      type="checkbox"
                      checked={selectedOS.has(key)}
                      onChange={() => toggleOS(key)}
                      className="column-checkbox"
                    />
                    <span className="column-label">{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="column-section">
            <h3 className="column-section-title">Image Metadata</h3>
            <div className="column-list">
              {filteredKeys.map((item) => {
                const token = schemaDefinitionIdToken(item.id);
                return (
                  <label key={token} className="column-item">
                    <input
                      type="checkbox"
                      checked={selected.has(token)}
                      onChange={() => toggle(token)}
                      className="column-checkbox"
                    />
                    <span className="column-label">{itemLabel(item)}</span>
                    <span className="column-count">({item.count} files)</span>
                  </label>
                );
              })}
              {filteredKeys.length === 0 &&
                filteredOSColumns.length === 0 &&
                searchTerm && (
                  <div className="no-results">
                    No columns match your search.
                  </div>
                )}
            </div>
          </div>
        </div>

        <div className="dialog-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() =>
              onSave(
                mergeSelection(orderBasis, selectedOS, selected, imageIds),
                resetWidths,
              )
            }
          >
            Save Changes
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

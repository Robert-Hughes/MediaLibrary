import { ModalDialog } from "./ModalDialog";
import { useState, useRef, useEffect, useMemo } from "react";
import { useWritableSchemaDefinitions } from "../hooks/useWritableSchemaDefinitions";
import { describeKind } from "./editors/editorHelpers";
import { filterTagInfosByFilename } from "../utils/tagGroupApplicability";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import type {
  MetadataDraftTarget,
  MetadataOccurrence,
  TagInfo,
} from "../types";
import {
  family7GroupFromSchemaId,
  metadataWriteSelectorsEqual,
  metadataWriteSelector,
  validateFamily1Group,
} from "../utils/metadataWriteTarget";
import { schemaDefinitionIdEquals } from "../utils/schemaDefinitionId";
import { metadataDraftTargetEquals } from "../utils/metadataDraftTarget";

interface Props {
  /**
   * Called once the user has chosen a writable key definition.
   */
  onSave: (
    target: Extract<MetadataDraftTarget, { kind: "NewProperty" }>,
  ) => void;
  onCancel: () => void;
  existingOccurrences?: readonly MetadataOccurrence[];
  initialTarget?: Extract<MetadataDraftTarget, { kind: "NewProperty" }>;
  pendingTargets?: readonly MetadataDraftTarget[];
  /** Filename of the photo being edited. Drives file-type filtering of
   * the suggestions so a JPEG doesn't surface Vorbis tags. */
  filename?: string;
}

const MAX_VISIBLE_RESULTS = 100;

export function NewPropertyDialog({
  onSave,
  onCancel,
  existingOccurrences,
  initialTarget,
  pendingTargets,
  filename,
}: Props) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedTag, setSelectedTag] = useState<TagInfo | null>(null);
  const [destinationGroup, setDestinationGroup] = useState(
    initialTarget?.write_target.group1 ?? "",
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const destinationInputRef = useRef<HTMLInputElement>(null);

  const writableDefinitions = useWritableSchemaDefinitions();

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    setSelectedTag(null);
    setDestinationGroup("");
  };

  const suggestions = useMemo(() => {
    if (writableDefinitions === "loading") return [];
    const applicable = filterTagInfosByFilename(writableDefinitions, filename);
    if (!searchQuery.trim()) return [];
    const lowerQuery = searchQuery.trim().toLowerCase();
    return applicable.filter((info) => {
      const friendlyName = `${info.group}:${info.name}`.toLowerCase();
      const name = info.name.toLowerCase();
      const description = (info.description ?? "").toLowerCase();
      const table = info.id.table.toLowerCase();
      const tagId = info.id.tag_id.toLowerCase();
      const kindText = describeKind(info.kind).toLowerCase();

      return (
        friendlyName.includes(lowerQuery) ||
        name.includes(lowerQuery) ||
        description.includes(lowerQuery) ||
        table.includes(lowerQuery) ||
        tagId.includes(lowerQuery) ||
        kindText.includes(lowerQuery)
      );
    });
  }, [writableDefinitions, searchQuery, filename]);

  const visibleSuggestions = suggestions.slice(0, MAX_VISIBLE_RESULTS);

  useEffect(() => {
    if (initialTarget && selectedTag) {
      destinationInputRef.current?.focus();
    } else if (!initialTarget) {
      searchInputRef.current?.focus();
    }
  }, [initialTarget, selectedTag, writableDefinitions]);

  useEffect(() => {
    if (!initialTarget || writableDefinitions === "loading") return;
    const info = writableDefinitions.find((candidate) =>
      schemaDefinitionIdEquals(candidate.id, initialTarget.schema_id),
    );
    if (!info) return;
    setSelectedTag(info);
    setDestinationGroup(initialTarget.write_target.group1);
    setSearchQuery(`${info.group}:${info.name}`);
  }, [initialTarget, writableDefinitions]);

  const writeTarget = selectedTag
    ? {
        group1: destinationGroup,
        group7: family7GroupFromSchemaId(selectedTag.id),
        tag_name: selectedTag.name,
      }
    : null;
  const destinationError = validateFamily1Group(destinationGroup);
  const occupiedOccurrence =
    selectedTag && writeTarget
      ? (existingOccurrences ?? []).find((occurrence) => {
          const observed = occurrence.observed_selector;
          return (
            (observed !== null &&
              metadataWriteSelectorsEqual(observed, writeTarget)) ||
            (observed === null &&
              schemaDefinitionIdEquals(occurrence.schema_id, selectedTag.id))
          );
        })
      : undefined;
  const pendingCollision =
    writeTarget === null
      ? undefined
      : pendingTargets?.find(
          (target) =>
            (!initialTarget ||
              !metadataDraftTargetEquals(target, initialTarget)) &&
            metadataWriteSelectorsEqual(target.write_target, writeTarget),
        );
  const isSelectedDuplicate =
    occupiedOccurrence !== undefined || pendingCollision !== undefined;

  const groupSuggestions = useMemo(() => {
    if (!selectedTag || writableDefinitions === "loading") return [];
    const applicable = filterTagInfosByFilename(writableDefinitions, filename);
    const values = new Set<string>([
      selectedTag.group,
      ...applicable.map((info) => info.group),
      ...(existingOccurrences ?? []).flatMap((occurrence) =>
        occurrence.observed_selector
          ? [occurrence.observed_selector.group1]
          : [],
      ),
    ]);
    return [
      selectedTag.group,
      ...Array.from(values)
        .filter((group) => group !== selectedTag.group)
        .sort((left, right) => left.localeCompare(right)),
    ];
  }, [existingOccurrences, filename, selectedTag, writableDefinitions]);

  const save = () => {
    if (!selectedTag || !writeTarget || destinationError || isSelectedDuplicate)
      return;
    onSave({
      kind: "NewProperty",
      schema_id: structuredClone(selectedTag.id),
      write_target: structuredClone(writeTarget),
    });
  };

  const disabled =
    !selectedTag || destinationError !== null || isSelectedDuplicate;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !disabled && selectedTag) {
      save();
    }
  };

  return (
    <ModalDialog
      open
      onDismiss={onCancel}
      aria-label={
        initialTarget ? "Edit property destination" : "Add new property"
      }
    >
      <div className="dialog-content" style={{ minWidth: "400px" }}>
        <h3>
          {initialTarget ? "Edit Property Destination" : "Add New Property"}
        </h3>
        <div
          className="dialog-body"
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          {writableDefinitions === "loading" ? (
            <div
              style={{
                padding: "32px",
                textAlign: "center",
                opacity: 0.8,
              }}
              data-testid="new-property-loading"
            >
              Loading writable schema definitions...
            </div>
          ) : (
            <div>
              <label
                htmlFor="new-property-search"
                style={{
                  display: "block",
                  marginBottom: "6px",
                  fontSize: "12px",
                  opacity: 0.8,
                }}
              >
                {initialTarget
                  ? "Property schema"
                  : "Search Writable Properties"}
              </label>
              <input
                id="new-property-search"
                ref={searchInputRef}
                type="text"
                className="dialog-input"
                value={searchQuery}
                onChange={
                  initialTarget
                    ? undefined
                    : (event) => handleSearchChange(event.target.value)
                }
                onKeyDown={initialTarget ? undefined : handleKeyDown}
                placeholder={
                  initialTarget
                    ? undefined
                    : "Search by name, group, ID, table..."
                }
                data-testid="new-property-key"
                autoComplete="off"
                readOnly={initialTarget !== undefined}
                style={{ width: "100%", boxSizing: "border-box" }}
              />

              <div
                className="dialog-results-list"
                hidden={initialTarget !== undefined}
                style={{
                  maxHeight: "220px",
                  overflowY: "auto",
                  padding: "6px",
                  marginTop: "10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                {!searchQuery.trim() ? (
                  <div
                    style={{
                      padding: "24px",
                      textAlign: "center",
                      opacity: 0.7,
                      fontSize: "13px",
                    }}
                  >
                    Type to search writable properties.
                  </div>
                ) : suggestions.length === 0 ? (
                  <div
                    style={{
                      padding: "24px",
                      textAlign: "center",
                      opacity: 0.6,
                      fontSize: "13px",
                    }}
                  >
                    No matching writable schema definitions found.
                  </div>
                ) : (
                  visibleSuggestions.map((info) => {
                    const token = schemaDefinitionIdToken(info.id);
                    const isSelected =
                      selectedTag !== null &&
                      schemaDefinitionIdToken(selectedTag.id) === token;
                    return (
                      <button
                        type="button"
                        key={token}
                        onClick={() => {
                          setSelectedTag(info);
                          setDestinationGroup(info.group);
                        }}
                        aria-pressed={isSelected}
                        className="dialog-results-option"
                        style={{
                          padding: "10px 14px",
                          cursor: "pointer",
                          textAlign: "left",
                          font: "inherit",
                        }}
                        data-testid={`schema-option-${token}`}
                      >
                        <div
                          style={{
                            fontWeight: "bold",
                            display: "flex",
                            justifyContent: "space-between",
                          }}
                        >
                          <span>
                            {info.group}:{info.name}
                          </span>
                          <span style={{ fontSize: "11px", opacity: 0.7 }}>
                            {describeKind(info.kind)}
                          </span>
                        </div>
                        <div
                          style={{
                            fontSize: "11px",
                            opacity: 0.8,
                            marginTop: "2px",
                          }}
                        >
                          <code>{info.id.table}</code> · ID{" "}
                          <code>{info.id.tag_id}</code>
                          {info.id.index !== undefined ? (
                            <>
                              {" · Index "}
                              <code>{info.id.index}</code>
                            </>
                          ) : null}
                        </div>
                        {info.description ? (
                          <div
                            style={{
                              fontSize: "11px",
                              opacity: 0.6,
                              marginTop: "4px",
                              fontStyle: "italic",
                            }}
                          >
                            {info.description}
                          </div>
                        ) : null}
                      </button>
                    );
                  })
                )}
                {suggestions.length > MAX_VISIBLE_RESULTS ? (
                  <div
                    style={{
                      padding: "8px",
                      textAlign: "center",
                      opacity: 0.7,
                    }}
                  >
                    Showing the first {MAX_VISIBLE_RESULTS} of{" "}
                    {suggestions.length} matches. Refine your search to see
                    others.
                  </div>
                ) : null}
              </div>

              {isSelectedDuplicate && (
                <p
                  className="dialog-hint editor-meta-hint editor-meta-hint-warning"
                  data-testid="new-property-duplicate-warning"
                  style={{
                    color: "var(--accent-warning, #aa6)",
                    marginTop: "8px",
                  }}
                >
                  ⚠{" "}
                  <code>
                    {selectedTag
                      ? `${selectedTag.group}:${selectedTag.name}`
                      : ""}
                  </code>{" "}
                  {pendingCollision
                    ? "is already used by another pending draft."
                    : occupiedOccurrence?.observed_selector
                      ? "uses a complete ExifTool destination already present in the file. Edit the existing occurrence instead."
                      : "has an existing same-schema occurrence without a safely identifiable write destination, so another destination cannot be created safely."}
                </p>
              )}
              {selectedTag ? (
                <div style={{ marginTop: "12px" }}>
                  <label htmlFor="new-property-destination-group">
                    Destination group
                  </label>
                  <div style={{ fontSize: "12px", opacity: 0.8 }}>
                    Default: <code>{selectedTag.group}</code>
                  </div>
                  <input
                    id="new-property-destination-group"
                    ref={destinationInputRef}
                    role="combobox"
                    aria-autocomplete="list"
                    aria-controls="new-property-group-suggestions"
                    list="new-property-group-suggestions"
                    className="dialog-input"
                    value={destinationGroup}
                    onChange={(event) =>
                      setDestinationGroup(event.currentTarget.value)
                    }
                    data-testid="new-property-destination-group"
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                  <datalist id="new-property-group-suggestions">
                    {groupSuggestions.map((group) => (
                      <option key={group} value={group} />
                    ))}
                  </datalist>
                  {destinationError ? (
                    <p
                      role="alert"
                      data-testid="new-property-destination-error"
                      style={{ color: "var(--accent-error, #e06c75)" }}
                    >
                      {destinationError}
                    </p>
                  ) : null}
                  <p style={{ fontSize: "12px", opacity: 0.8 }}>
                    You may enter another ExifTool family-1 group. Custom
                    destinations are checked when the edit is applied and may be
                    rejected by ExifTool. Suggestions do not guarantee that this
                    schema is writable there.
                  </p>
                  {writeTarget ? (
                    <div data-testid="new-property-write-selector">
                      Write selector:{" "}
                      <code>{metadataWriteSelector(writeTarget)}</code>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          )}
        </div>
        <div className="dialog-footer">
          <button
            className="dialog-btn dialog-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            className="dialog-btn dialog-btn-primary"
            onClick={save}
            disabled={disabled}
            data-testid="new-property-next"
          >
            {initialTarget ? "Save destination" : "Next"}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}

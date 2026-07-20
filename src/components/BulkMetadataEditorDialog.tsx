import { useMemo, useState } from "react";
import type {
  ImageMetadataOccurrencesStore,
  MetadataDraftEdit,
  PhotoInfo,
  TagInfo,
} from "../types";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import type {
  BulkMetadataDraftPlan,
  BulkMetadataDraftRequest,
} from "../bulkMetadataDrafts";
import { computeEffectiveMetadataKeyFrequency } from "../utils/metadataKeyFrequency";
import { useTagInfos } from "../hooks/useTagInfo";
import { useWritableSchemaDefinitions } from "../hooks/useWritableSchemaDefinitions";
import { filterTagInfosByFilename } from "../utils/tagGroupApplicability";
import {
  schemaDefinitionIdToken,
  tagInfoDisplayName,
} from "../utils/schemaDefinitionId";
import { metadataEditCapabilities } from "../metadataEditCapabilities";
import { ModalDialog } from "./ModalDialog";
import { TypedValueEditor } from "./editors/TypedValueEditor";

interface Props {
  photos: PhotoInfo[];
  imageMetadataOccurrences: ImageMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
  onPreview: (
    request: BulkMetadataDraftRequest,
  ) =>
    | { kind: "ready"; plan: BulkMetadataDraftPlan }
    | { kind: "blocked"; reason: string; relativePath?: string };
  onStage: (request: BulkMetadataDraftRequest) => boolean;
  onClose: () => void;
}

type Candidate = { info: TagInfo; count: number };
type Phase = "choose" | "editor" | "preview";

function appliesToEveryPhoto(
  info: TagInfo,
  photos: readonly PhotoInfo[],
): boolean {
  return photos.every(
    (photo) => filterTagInfosByFilename([info], photo.filename).length === 1,
  );
}

function previewSummary(plan: BulkMetadataDraftPlan): string[] {
  const { preview } = plan;
  return [
    preview.existingOccurrencesSet > 0
      ? `${preview.existingOccurrencesSet} existing occurrence${preview.existingOccurrencesSet === 1 ? "" : "s"} will be set.`
      : null,
    preview.newPropertiesSet > 0
      ? `${preview.newPropertiesSet} new or staged propert${preview.newPropertiesSet === 1 ? "y" : "ies"} will be set.`
      : null,
    preview.existingOccurrencesDeleted > 0
      ? `${preview.existingOccurrencesDeleted} existing occurrence${preview.existingOccurrencesDeleted === 1 ? "" : "s"} will be deleted.`
      : null,
    preview.stagedCreationsCancelled > 0
      ? `${preview.stagedCreationsCancelled} staged creation${preview.stagedCreationsCancelled === 1 ? "" : "s"} will be cancelled.`
      : null,
    preview.draftsCleared > 0
      ? `${preview.draftsCleared} redundant draft${preview.draftsCleared === 1 ? "" : "s"} will be cleared.`
      : null,
    preview.noOpPhotoCount > 0
      ? `${preview.noOpPhotoCount} photo${preview.noOpPhotoCount === 1 ? " is" : "s are"} already in the requested state.`
      : null,
  ].filter((line): line is string => line !== null);
}

export function BulkMetadataEditorDialog({
  photos,
  imageMetadataOccurrences,
  targetDraftEdits,
  onPreview,
  onStage,
  onClose,
}: Props) {
  const frequencies = useMemo(
    () =>
      computeEffectiveMetadataKeyFrequency(
        photos,
        imageMetadataOccurrences,
        targetDraftEdits,
      ),
    [photos, imageMetadataOccurrences, targetDraftEdits],
  );
  const presentInfos = useTagInfos(frequencies.map(({ id }) => id));
  const writableDefinitions = useWritableSchemaDefinitions();
  const [search, setSearch] = useState("");
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [operation, setOperation] = useState<"Set" | "Delete">("Set");
  const [merge, setMerge] = useState(false);
  const [phase, setPhase] = useState<Phase>("choose");
  const [request, setRequest] = useState<BulkMetadataDraftRequest | null>(null);
  const [plan, setPlan] = useState<BulkMetadataDraftPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const countByToken = new Map(
      frequencies.map(({ id, count }) => [schemaDefinitionIdToken(id), count]),
    );
    const byToken = new Map<string, Candidate>();
    if (writableDefinitions !== "loading") {
      for (const info of writableDefinitions) {
        if (!appliesToEveryPhoto(info, photos)) continue;
        if (metadataEditCapabilities(info).groupedEditor !== null) continue;
        const token = schemaDefinitionIdToken(info.id);
        byToken.set(token, { info, count: countByToken.get(token) ?? 0 });
      }
    }
    for (const { id, count } of frequencies) {
      const token = schemaDefinitionIdToken(id);
      const info = presentInfos[token];
      if (!info || info === "loading") continue;
      if (metadataEditCapabilities(info).groupedEditor !== null) continue;
      if (!byToken.has(token)) byToken.set(token, { info, count });
    }
    return Array.from(byToken.values()).sort((left, right) =>
      tagInfoDisplayName(left.info).localeCompare(
        tagInfoDisplayName(right.info),
      ),
    );
  }, [frequencies, photos, presentInfos, writableDefinitions]);

  const lowerSearch = search.trim().toLowerCase();
  const filteredCandidates = candidates.filter(({ info }) => {
    if (!lowerSearch) return true;
    return [
      tagInfoDisplayName(info),
      info.group,
      info.name,
      info.id.table,
      info.id.tag_id,
      info.description ?? "",
      info.kind.kind,
    ].some((value) => value.toLowerCase().includes(lowerSearch));
  });
  const selected =
    candidates.find(
      ({ info }) => schemaDefinitionIdToken(info.id) === selectedToken,
    ) ?? null;
  const capabilities = selected
    ? metadataEditCapabilities(selected.info)
    : null;
  const mergeAvailable = capabilities?.mergeMode !== null;

  const review = (nextRequest: BulkMetadataDraftRequest) => {
    const result = onPreview(nextRequest);
    if (result.kind === "blocked") {
      setError(
        result.relativePath
          ? `${result.reason} Affected file: ${result.relativePath}`
          : result.reason,
      );
      setPhase("choose");
      return;
    }
    setError(null);
    setRequest(nextRequest);
    setPlan(result.plan);
    setPhase("preview");
  };

  if (phase === "editor" && selected) {
    return (
      <TypedValueEditor
        propertyId={selected.info.id}
        propertyLabel={tagInfoDisplayName(selected.info)}
        contextHint={
          <p className="dialog-hint" data-testid="bulk-editor-context-hint">
            {merge && mergeAvailable
              ? `The entered value will be merged with the effective value on each of the ${photos.length} selected photos.`
              : `The entered value will replace this property on all ${photos.length} selected photos, creating it where missing.`}
          </p>
        }
        onSaveMetadata={(edit: MetadataDraftEdit) => {
          if (edit.intent !== "Set" || edit.value === null) {
            setError("Use the Delete action to remove this property.");
            setPhase("choose");
            return;
          }
          review({
            operation: "Set",
            tagInfo: structuredClone(selected.info),
            edit: structuredClone(edit),
            merge: merge && mergeAvailable,
          });
        }}
        onCancel={() => setPhase("choose")}
      />
    );
  }

  return (
    <ModalDialog
      open
      onDismiss={onClose}
      aria-label={`Bulk edit ${photos.length} photos`}
      testId="bulk-metadata-dialog-overlay"
    >
      <div
        className="dialog-content column-dialog"
        data-testid="bulk-metadata-dialog"
        style={{ minWidth: "560px", maxWidth: "760px" }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">
            Bulk Edit ({photos.length}{" "}
            {photos.length === 1 ? "photo" : "photos"})
          </h2>
          <button className="dialog-close-btn" onClick={onClose}>
            &times;
          </button>
        </div>

        {phase === "preview" && request && plan ? (
          <>
            <div className="dialog-body">
              <h3>
                {request.operation}{" "}
                {selected ? tagInfoDisplayName(selected.info) : "metadata"}
              </h3>
              <p>
                {plan.preview.affectedPhotoCount} of {plan.preview.photoCount}{" "}
                selected photos will receive draft changes.
              </p>
              <ul>
                {previewSummary(plan).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <p className="dialog-hint">
                Only drafts will change. Files are not modified until you use
                Apply edits.
              </p>
            </div>
            <div className="dialog-footer">
              <button
                className="btn-secondary"
                onClick={() => setPhase("choose")}
              >
                Back
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  if (onStage(request)) onClose();
                }}
              >
                Stage draft edits
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="dialog-body column-list-area">
              <p className="dialog-hint">
                Choose one exact metadata property, then Set or Delete it across
                the selected photos.
              </p>
              {error ? (
                <p role="alert" className="editor-meta-hint-warning">
                  {error}
                </p>
              ) : null}
              <div className="column-search">
                <input
                  type="text"
                  placeholder="Search metadata properties..."
                  value={search}
                  onChange={(event) => setSearch(event.currentTarget.value)}
                  className="column-search-input"
                  autoFocus
                />
              </div>
              <div
                className="dialog-results-list"
                style={{ maxHeight: "300px", overflowY: "auto" }}
              >
                {writableDefinitions === "loading" &&
                candidates.length === 0 ? (
                  <div className="no-results">
                    Loading metadata properties...
                  </div>
                ) : filteredCandidates.length === 0 ? (
                  <div className="no-results">
                    No metadata properties match.
                  </div>
                ) : (
                  filteredCandidates.map(({ info, count }) => {
                    const token = schemaDefinitionIdToken(info.id);
                    const active = token === selectedToken;
                    return (
                      <button
                        type="button"
                        key={token}
                        className="dialog-results-option"
                        aria-pressed={active}
                        onClick={() => {
                          setSelectedToken(token);
                          setMerge(false);
                          setError(null);
                        }}
                        style={{ width: "100%", textAlign: "left" }}
                      >
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: "16px",
                          }}
                        >
                          <strong>{tagInfoDisplayName(info)}</strong>
                          <span>
                            {count} of {photos.length} photos
                          </span>
                        </div>
                        <div style={{ fontSize: "11px", opacity: 0.75 }}>
                          {info.kind.kind} · {info.id.table} / {info.id.tag_id}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              {selected ? (
                <div style={{ marginTop: "18px" }}>
                  <h3>{tagInfoDisplayName(selected.info)}</h3>
                  <label style={{ marginRight: "20px" }}>
                    <input
                      type="radio"
                      name="bulk-operation"
                      checked={operation === "Set"}
                      onChange={() => setOperation("Set")}
                    />{" "}
                    Set
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="bulk-operation"
                      checked={operation === "Delete"}
                      onChange={() => {
                        setOperation("Delete");
                        setMerge(false);
                      }}
                    />{" "}
                    Delete
                  </label>
                  {operation === "Set" && mergeAvailable ? (
                    <label style={{ display: "block", marginTop: "12px" }}>
                      <input
                        type="checkbox"
                        checked={merge}
                        onChange={(event) =>
                          setMerge(event.currentTarget.checked)
                        }
                      />{" "}
                      Merge with existing value
                    </label>
                  ) : null}
                  <p className="dialog-hint">
                    {operation === "Set"
                      ? "Set overwrites every existing value and creates the property where it is missing."
                      : "Delete removes every exact occurrence and cancels staged creations."}
                  </p>
                </div>
              ) : null}
            </div>
            <div className="dialog-footer">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!selected || !selected.info.writable}
                onClick={() => {
                  if (!selected) return;
                  if (operation === "Delete") {
                    review({
                      operation: "Delete",
                      schemaId: structuredClone(selected.info.id),
                    });
                  } else {
                    setPhase("editor");
                  }
                }}
              >
                {operation === "Delete" ? "Review Delete" : "Enter value..."}
              </button>
            </div>
          </>
        )}
      </div>
    </ModalDialog>
  );
}

import { useMemo, useState } from "react";
import type {
  FileMetadataOccurrencesStore,
  MetadataDraftEdit,
  FileInfo,
  SchemaDefinitionId,
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
import {
  schemaDefinitionIdToken,
  tagInfoDisplayName,
} from "../utils/schemaDefinitionId";
import { metadataEditCapabilities } from "../metadataEditCapabilities";
import {
  filterTagInfosByFilename,
  tagInfoSupportsMetadataWrite,
} from "../utils/metadataWriteSupport";
import { GPS_IDS } from "../metadata/knownIds";
import type { GpsTagGroup } from "../metadata/tag_overrides";
import { buildEffectiveMetadataForFile } from "../utils/effectiveMetadata";
import { resolveEffectiveGpsForFile } from "../utils/effectiveGps";
import { ModalDialog } from "./ModalDialog";
import { TypedValueEditor } from "./editors/TypedValueEditor";

interface Props {
  files: FileInfo[];
  fileMetadataOccurrences: FileMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
  onPreview: (
    request: BulkMetadataDraftRequest,
  ) =>
    | { kind: "ready"; plan: BulkMetadataDraftPlan }
    | { kind: "blocked"; reason: string; relativePath?: string };
  onStage: (request: BulkMetadataDraftRequest) => boolean;
  onClose: () => void;
}

type Candidate =
  | { kind: "schema"; token: string; info: TagInfo; count: number }
  | {
      kind: "gps";
      token: "gps-location";
      group: GpsTagGroup;
      count: number;
    };
type Phase = "choose" | "editor" | "preview";

const GPS_GROUP: GpsTagGroup = {
  latitudeId: GPS_IDS.latitude,
  latitudeRefId: GPS_IDS.latitudeRef,
  longitudeId: GPS_IDS.longitude,
  longitudeRefId: GPS_IDS.longitudeRef,
  altitudeId: GPS_IDS.altitude,
  altitudeRefId: GPS_IDS.altitudeRef,
};

const GPS_IDS_ARRAY: readonly SchemaDefinitionId[] = [
  GPS_GROUP.latitudeId,
  GPS_GROUP.latitudeRefId,
  GPS_GROUP.longitudeId,
  GPS_GROUP.longitudeRefId,
  GPS_GROUP.altitudeId,
  GPS_GROUP.altitudeRefId,
];

function appliesToEveryFile(
  info: TagInfo,
  files: readonly FileInfo[],
): boolean {
  return files.every(
    (file) => filterTagInfosByFilename([info], file.filename).length === 1,
  );
}

function candidateLabel(candidate: Candidate): string {
  return candidate.kind === "gps"
    ? "GPS Location"
    : tagInfoDisplayName(candidate.info);
}

function tagInfoMatchesSearch(info: TagInfo, lowerSearch: string): boolean {
  return [
    tagInfoDisplayName(info),
    info.group,
    info.name,
    info.id.table,
    info.id.tag_id,
    info.description ?? "",
    info.kind.kind,
  ].some((value) => value.toLowerCase().includes(lowerSearch));
}

function readOnlyReason(candidate: Candidate | null): string | null {
  if (candidate === null || candidate.kind === "gps") return null;
  if (!candidate.info.writable) {
    return "ExifTool's schema marks this property as read-only.";
  }
  if (candidate.info.kind.kind === "Binary") {
    return "This property contains binary data, which MediaLibrary cannot safely write.";
  }
  if (candidate.info.kind.kind === "Unknown") {
    return "ExifTool does not provide a supported writable datatype for this property.";
  }
  if (
    !tagInfoSupportsMetadataWrite(candidate.info, undefined, "DeleteExisting")
  ) {
    return "This property's schema is not supported by the metadata write pipeline.";
  }
  return null;
}

function DialogErrorStatus({
  title,
  message,
  testId,
}: {
  title: string;
  message: string;
  testId: string;
}) {
  return (
    <div
      className="error-banner error-banner--error bulk-editor-error-status"
      role="alert"
      data-testid={testId}
    >
      <div className="error-banner-content">
        <span className="error-banner-icon" aria-hidden="true">
          ⛔
        </span>
        <div className="error-banner-text">
          <div className="error-banner-title">{title}</div>
          <div className="error-banner-message">{message}</div>
        </div>
      </div>
    </div>
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
    preview.noOpFileCount > 0
      ? `${preview.noOpFileCount} file${preview.noOpFileCount === 1 ? " is" : "s are"} already in the requested state.`
      : null,
  ].filter((line): line is string => line !== null);
}

export function BulkMetadataEditorDialog({
  files,
  fileMetadataOccurrences,
  targetDraftEdits,
  onPreview,
  onStage,
  onClose,
}: Props) {
  const frequencies = useMemo(
    () =>
      computeEffectiveMetadataKeyFrequency(
        files,
        fileMetadataOccurrences,
        targetDraftEdits,
      ),
    [files, fileMetadataOccurrences, targetDraftEdits],
  );
  const allLookupIds = useMemo(
    () => [...frequencies.map(({ id }) => id), ...GPS_IDS_ARRAY],
    [frequencies],
  );
  const tagInfos = useTagInfos(allLookupIds);
  const writableDefinitions = useWritableSchemaDefinitions();
  const [search, setSearch] = useState("");
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [operation, setOperation] = useState<"Set" | "Delete">("Set");
  const [merge, setMerge] = useState(false);
  const [phase, setPhase] = useState<Phase>("choose");
  const [request, setRequest] = useState<BulkMetadataDraftRequest | null>(null);
  const [plan, setPlan] = useState<BulkMetadataDraftPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lowerSearch = search.trim().toLowerCase();

  const candidates = useMemo(() => {
    const countByToken = new Map(
      frequencies.map(({ id, count }) => [schemaDefinitionIdToken(id), count]),
    );
    const byToken = new Map<string, Candidate>();
    if (lowerSearch && writableDefinitions !== "loading") {
      for (const info of writableDefinitions) {
        if (!tagInfoMatchesSearch(info, lowerSearch)) continue;
        if (!appliesToEveryFile(info, files)) continue;
        if (metadataEditCapabilities(info).groupedEditor !== null) continue;
        const token = schemaDefinitionIdToken(info.id);
        byToken.set(token, {
          kind: "schema",
          token,
          info,
          count: countByToken.get(token) ?? 0,
        });
      }
    }
    for (const { id, count } of frequencies) {
      const token = schemaDefinitionIdToken(id);
      const info = tagInfos[token];
      if (!info || info === "loading") continue;
      if (metadataEditCapabilities(info).groupedEditor !== null) continue;
      if (lowerSearch && !tagInfoMatchesSearch(info, lowerSearch)) continue;
      if (!byToken.has(token)) {
        byToken.set(token, { kind: "schema", token, info, count });
      }
    }

    const gpsInfos = GPS_IDS_ARRAY.map(
      (id) => tagInfos[schemaDefinitionIdToken(id)],
    );
    if (
      gpsInfos.every(
        (info): info is TagInfo =>
          info !== undefined &&
          info !== null &&
          info !== "loading" &&
          info.writable &&
          appliesToEveryFile(info, files),
      )
    ) {
      const count = files.filter((file) => {
        const effective = resolveEffectiveGpsForFile({
          occurrences: fileMetadataOccurrences.get(file.relative_path),
          targetDrafts: targetDraftEdits[file.relative_path],
        });
        return effective.lat !== null && effective.lon !== null;
      }).length;
      const gpsMatches = [
        "gps location",
        "latitude",
        "longitude",
        "altitude",
      ].some((value) => value.includes(lowerSearch));
      const includeGps = lowerSearch ? gpsMatches : count > 0;
      if (includeGps) {
        byToken.set("gps-location", {
          kind: "gps",
          token: "gps-location",
          group: structuredClone(GPS_GROUP),
          count,
        });
      }
    }

    return Array.from(byToken.values()).sort((left, right) =>
      candidateLabel(left).localeCompare(candidateLabel(right)),
    );
  }, [
    frequencies,
    fileMetadataOccurrences,
    files,
    lowerSearch,
    tagInfos,
    targetDraftEdits,
    writableDefinitions,
  ]);
  const selected =
    candidates.find((candidate) => candidate.token === selectedToken) ?? null;
  const selectedReadOnlyReason = readOnlyReason(selected);
  const selectedSetUnavailable =
    selected?.kind === "schema" &&
    !files.every((file) =>
      tagInfoSupportsMetadataWrite(selected.info, file.filename, "Set"),
    );
  const capabilities =
    selected?.kind === "schema"
      ? metadataEditCapabilities(selected.info)
      : null;
  const mergeAvailable = capabilities?.mergeMode != null;

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
    const contextHint = (
      <p className="dialog-hint" data-testid="bulk-editor-context-hint">
        {merge && mergeAvailable
          ? `The entered value will be merged with the effective value on each of the ${files.length} selected files.`
          : `The entered value will replace this property on all ${files.length} selected files, creating it where missing.`}
      </p>
    );
    if (selected.kind === "gps") {
      const seedFile = files[0];
      const seedInput = {
        occurrences: seedFile
          ? fileMetadataOccurrences.get(seedFile.relative_path)
          : undefined,
        targetDrafts: seedFile
          ? targetDraftEdits[seedFile.relative_path]
          : undefined,
      };
      return (
        <TypedValueEditor
          propertyId={selected.group.latitudeId}
          propertyLabel="GPS Location"
          contextHint={contextHint}
          editorMode="gps"
          metadataForFile={buildEffectiveMetadataForFile(seedInput, {
            ids: GPS_IDS_ARRAY,
          })}
          effectiveGps={resolveEffectiveGpsForFile(seedInput)}
          onSaveMetadata={() => {
            setError("GPS Location must be saved through its grouped editor.");
            setPhase("choose");
          }}
          onSaveMetadataBatch={(edits) =>
            review({
              operation: "SetGps",
              group: structuredClone(selected.group),
              edits: structuredClone(edits),
            })
          }
          onCancel={() => setPhase("choose")}
        />
      );
    }
    return (
      <TypedValueEditor
        propertyId={selected.info.id}
        propertyLabel={tagInfoDisplayName(selected.info)}
        contextHint={contextHint}
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
      aria-label={`Bulk edit ${files.length} files`}
      testId="bulk-metadata-dialog-overlay"
    >
      <div
        className="dialog-content column-dialog"
        data-testid="bulk-metadata-dialog"
        style={{ minWidth: "560px", maxWidth: "760px" }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">
            Bulk Edit ({files.length} {files.length === 1 ? "file" : "files"})
          </h2>
          <button className="dialog-close-btn" onClick={onClose}>
            &times;
          </button>
        </div>

        {phase === "preview" && request && plan ? (
          <>
            <div className="dialog-body">
              <h3>
                {request.operation.startsWith("Set") ? "Set" : "Delete"}{" "}
                {selected ? candidateLabel(selected) : "metadata"}
              </h3>
              <p>
                {plan.preview.affectedFileCount} of {plan.preview.fileCount}{" "}
                selected files will receive draft changes.
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
                the selected files.
              </p>
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
                ) : candidates.length === 0 ? (
                  <div className="no-results">
                    No metadata properties match.
                  </div>
                ) : (
                  candidates.map((candidate) => {
                    const active = candidate.token === selectedToken;
                    const candidateReadOnly =
                      readOnlyReason(candidate) !== null;
                    return (
                      <button
                        type="button"
                        key={candidate.token}
                        className="dialog-results-option"
                        aria-pressed={active}
                        onClick={() => {
                          setSelectedToken(candidate.token);
                          if (
                            candidate.kind === "schema" &&
                            tagInfoSupportsMetadataWrite(
                              candidate.info,
                              undefined,
                              "DeleteExisting",
                            ) &&
                            !files.every((file) =>
                              tagInfoSupportsMetadataWrite(
                                candidate.info,
                                file.filename,
                                "Set",
                              ),
                            )
                          ) {
                            setOperation("Delete");
                          }
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
                          <strong className="bulk-editor-candidate-label">
                            {candidateLabel(candidate)}
                            {candidate.kind === "gps" ? (
                              <span className="bulk-editor-grouped-badge">
                                Grouped field
                              </span>
                            ) : null}
                          </strong>
                          <span>
                            {candidate.count} of {files.length} files
                          </span>
                        </div>
                        <div style={{ fontSize: "11px", opacity: 0.75 }}>
                          {candidate.kind === "gps"
                            ? "Grouped GPS coordinate and altitude fields"
                            : `${candidate.info.kind.kind} · ${candidate.info.id.table} / ${candidate.info.id.tag_id}${candidateReadOnly ? " · Read-only" : ""}`}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>

              {selected ? (
                <div style={{ marginTop: "18px" }}>
                  <h3>{candidateLabel(selected)}</h3>
                  {selectedReadOnlyReason ? (
                    <DialogErrorStatus
                      title="This property is read-only"
                      message={selectedReadOnlyReason}
                      testId="bulk-editor-read-only-status"
                    />
                  ) : null}
                  <fieldset
                    disabled={selectedReadOnlyReason !== null}
                    className="bulk-editor-operation-fieldset"
                  >
                    <label style={{ marginRight: "20px" }}>
                      <input
                        type="radio"
                        name="bulk-operation"
                        checked={operation === "Set"}
                        disabled={selectedSetUnavailable}
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
                  </fieldset>
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
              {error ? (
                <DialogErrorStatus
                  title="Bulk edit could not be previewed"
                  message={error}
                  testId="bulk-editor-error-status"
                />
              ) : null}
            </div>
            <div className="dialog-footer">
              <button className="btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn-primary"
                disabled={!selected || selectedReadOnlyReason !== null}
                onClick={() => {
                  if (!selected) return;
                  if (operation === "Delete") {
                    review(
                      selected.kind === "gps"
                        ? {
                            operation: "DeleteGps",
                            group: structuredClone(selected.group),
                          }
                        : {
                            operation: "Delete",
                            schemaId: structuredClone(selected.info.id),
                          },
                    );
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

import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import type {
  ImageMetadataEntry,
  ImageMetadataOccurrencesStore,
  MetadataDraftEdit,
  FileInfo,
  ThumbnailStore,
  VisibleColumn,
  SchemaDefinitionId,
} from "../types";
import type { TargetDraftCollection } from "../targetDraftEdits";
import { formatFileRowDate } from "../utils/fileDate";
import { HighlightedText } from "./HighlightedText";
import { Spinner } from "./Spinner";
import { formatMetadataValue } from "../draft";
import { useTagInfo } from "../hooks/useTagInfo";
import { metadataGet } from "../utils/metadataCollection";
import { schemaDefinitionIdToken } from "../utils/schemaDefinitionId";
import {
  buildSchemaDraftDisplayProjection,
  type SchemaDraftDisplayProjection,
} from "../targetDraftView";
import { schemaMetadataCollectionFromOccurrences } from "../utils/schemaMetadataProjection";

const EMPTY_CELL = "—";

function CellContent({
  text,
  draftValue,
  searchQuery,
}: {
  text: string;
  draftValue?: string | null;
  searchQuery: string;
}) {
  if (draftValue !== undefined) {
    return (
      <>
        <s className="draft-original" style={{ opacity: 0.6 }}>
          <HighlightedText text={text} searchQuery={searchQuery} />
        </s>{" "}
        <strong className="draft-new">
          <HighlightedText
            text={draftValue === null ? EMPTY_CELL : draftValue}
            searchQuery={searchQuery}
          />
        </strong>
      </>
    );
  }
  return <HighlightedText text={text} searchQuery={searchQuery} />;
}

function formatMetadataCellValue(
  id: SchemaDefinitionId,
  v: ImageMetadataEntry | undefined,
  tagInfo: Exclude<ReturnType<typeof useTagInfo>, "loading">,
): string {
  if (v === undefined) return EMPTY_CELL;
  const s = formatMetadataValue({ schemaId: id, value: v, tagInfo });
  return s === "" ? EMPTY_CELL : s;
}

function MetadataCellContent({
  id,
  value,
  draft,
  searchQuery,
}: {
  id: SchemaDefinitionId;
  value: ImageMetadataEntry | undefined;
  draft?: MetadataDraftEdit;
  searchQuery: string;
}) {
  const tag = useTagInfo(id);
  const tagInfo = tag !== "loading" ? tag : null;
  return (
    <CellContent
      text={formatMetadataCellValue(id, value, tagInfo)}
      draftValue={
        draft === undefined
          ? undefined
          : draft.intent === "Delete"
            ? null
            : formatMetadataValue({
                schemaId: id,
                value: draft.value,
                tagInfo,
              })
      }
      searchQuery={searchQuery}
    />
  );
}

function osValue(file: FileInfo, key: string): number | null {
  if (key === "date_modified") return file.date_modified;
  if (key === "date_created") return file.date_created;
  return null;
}

interface RowProps {
  file: FileInfo;
  index: number;
  selected: boolean;
  thumbnails: ThumbnailStore;
  imageMetadataOccurrences: ImageMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftCollection;
  visibleColumns: VisibleColumn[];
  onSelect: (
    index: number,
    modifiers: { ctrl: boolean; shift: boolean },
  ) => void;
  onFileOpen: (index: number) => void;
  onContextMenu: (e: React.MouseEvent, index: number) => void;
  virtualStart: number;
  searchQuery?: string;
}
export const FileRow = memo(function FileRow({
  file,
  index,
  selected,
  thumbnails,
  imageMetadataOccurrences,
  targetDraftEdits,
  visibleColumns,
  onSelect,
  onFileOpen,
  onContextMenu,
  virtualStart,
  searchQuery = "",
}: RowProps) {
  const subscribeThumb = useCallback(
    (cb: () => void) => thumbnails.subscribe(file.relative_path, cb),
    [thumbnails, file.relative_path],
  );
  const getThumbSnapshot = useCallback(
    () => thumbnails.get(file.relative_path),
    [thumbnails, file.relative_path],
  );
  const thumbnail = useSyncExternalStore(subscribeThumb, getThumbSnapshot);

  const subscribeOccurrences = useCallback(
    (callback: () => void) =>
      imageMetadataOccurrences.subscribe(file.relative_path, callback),
    [imageMetadataOccurrences, file.relative_path],
  );
  const getOccurrencesSnapshot = useCallback(
    () => imageMetadataOccurrences.get(file.relative_path),
    [imageMetadataOccurrences, file.relative_path],
  );
  const occurrences = useSyncExternalStore(
    subscribeOccurrences,
    getOccurrencesSnapshot,
  );
  const metadata = useMemo(
    () =>
      occurrences === "loading"
        ? undefined
        : schemaMetadataCollectionFromOccurrences(occurrences),
    [occurrences],
  );
  const presentedDraftEdits: SchemaDraftDisplayProjection = useMemo(
    () =>
      buildSchemaDraftDisplayProjection({
        occurrences,
        targetDrafts: targetDraftEdits,
      }),
    [occurrences, targetDraftEdits],
  );
  const isLoading = thumbnail === "loading";
  const hasSrc = thumbnail !== "loading" && thumbnail !== "failed";
  const src = hasSrc ? `data:image/jpeg;base64,${thumbnail}` : null;

  const metadataLoading = occurrences === "loading";

  const handleSelect = useCallback(
    (e: React.MouseEvent) =>
      onSelect(index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }),
    [onSelect, index],
  );
  const handleDoubleClick = useCallback(
    () => onFileOpen(index),
    [onFileOpen, index],
  );
  const handleContextMenuEvent = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, index),
    [onContextMenu, index],
  );

  const targetDraftCount = Object.keys(targetDraftEdits).length;
  const hasDrafts = targetDraftCount > 0;
  const rowClass = `file-row ${index % 2 === 0 ? "file-row--even" : "file-row--odd"} ${selected ? "file-row--selected" : ""}`;

  // Index of the first image-metadata cell — used to place exactly one spinner
  // per row while metadata is loading (per-cell spinners were O(rows × cols)).
  const firstImageIdx = visibleColumns.findIndex((c) => c.kind === "image");

  return (
    <div
      className={rowClass}
      data-testid="file-row"
      data-path={file.relative_path}
      data-index={index}
      onClick={handleSelect}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenuEvent}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${virtualStart}px)`,
        cursor: "pointer",
        gridTemplateColumns: "var(--grid-columns)",
      }}
    >
      <div className="grid-cell grid-cell-thumb">
        <div className="file-thumb">
          {src ? (
            <img src={src} alt="" className="file-thumb-img" />
          ) : isLoading ? (
            <div className="file-thumb-spinner">
              <Spinner className="file-thumb-spin-inner" />
            </div>
          ) : (
            <div className="file-thumb-placeholder" />
          )}
        </div>
      </div>
      <div
        className="grid-cell grid-cell-path"
        data-col="relative_path"
        data-testid="file-path"
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span className="file-cell-text">
            <CellContent
              text={file.relative_path}
              draftValue={undefined}
              searchQuery={searchQuery}
            />
          </span>
        </div>
        {hasDrafts && (
          <span
            className="row-draft-badge"
            title={`${targetDraftCount} pending edit(s)`}
          >
            {targetDraftCount} draft edit
            {targetDraftCount === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {visibleColumns.map((col, i) => {
        if (col.kind === "os") {
          const testId =
            col.key === "date_modified"
              ? "file-date-modified"
              : col.key === "date_created"
                ? "file-date-created"
                : undefined;
          return (
            <div
              key={col.key}
              className="grid-cell grid-cell-date"
              data-col={col.key}
              data-testid={testId}
            >
              <CellContent
                text={formatFileRowDate(osValue(file, col.key))}
                draftValue={undefined}
                searchQuery={searchQuery}
              />
            </div>
          );
        }
        return (
          <div
            key={schemaDefinitionIdToken(col.id)}
            className="grid-cell grid-cell-metadata"
            data-col={schemaDefinitionIdToken(col.id)}
          >
            {metadataLoading ? (
              i === firstImageIdx ? (
                <Spinner
                  className="cell-spinner"
                  aria-label="Loading"
                  data-testid="metadata-loading"
                />
              ) : (
                <span className="cell-loading-placeholder" aria-hidden="true">
                  {EMPTY_CELL}
                </span>
              )
            ) : (
              <MetadataCellContent
                id={col.id}
                value={metadata ? metadataGet(metadata, col.id) : undefined}
                draft={
                  presentedDraftEdits[schemaDefinitionIdToken(col.id)]?.edit
                }
                searchQuery={searchQuery}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

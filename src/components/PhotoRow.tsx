import { memo, useCallback, useSyncExternalStore } from "react";
import type {
  ImageMetadataEntry,
  ImageMetadataStore,
  MetadataDraftEdit,
  PhotoInfo,
  ThumbnailStore,
  VisibleColumn,
} from "../types";
import { formatPhotoRowDate } from "../utils/photoDate";
import { HighlightedText } from "./HighlightedText";
import { Spinner } from "./Spinner";
import {
  displayStringOfMetadataDraft,
  variantToDisplayString as metadataValueToDisplayString,
} from "../draft";

function CellContent({
  text,
  draft,
  searchQuery,
}: {
  text: string;
  draft?: MetadataDraftEdit;
  searchQuery: string;
}) {
  const draftValue = displayStringOfMetadataDraft(draft);
  if (draftValue !== undefined) {
    return (
      <>
        <s className="draft-original" style={{ opacity: 0.6 }}>
          <HighlightedText text={text} searchQuery={searchQuery} />
        </s>{" "}
        <strong className="draft-new">
          <HighlightedText
            text={draftValue === null ? "â€”" : draftValue}
            searchQuery={searchQuery}
          />
        </strong>
      </>
    );
  }
  return <HighlightedText text={text} searchQuery={searchQuery} />;
}

function formatMetadataValue(v: ImageMetadataEntry | undefined): string {
  if (v === undefined) return "â€”";
  const s = metadataValueToDisplayString(v);
  return s === "" ? "â€”" : s;
}

function osValue(photo: PhotoInfo, key: string): number | null {
  if (key === "date_modified") return photo.date_modified;
  if (key === "date_created") return photo.date_created;
  return null;
}

interface RowProps {
  photo: PhotoInfo;
  index: number;
  selected: boolean;
  thumbnails: ThumbnailStore;
  imageMetadata: ImageMetadataStore;
  visibleColumns: VisibleColumn[];
  draftEdits?: Record<string, MetadataDraftEdit>;
  onSelect: (
    index: number,
    modifiers: { ctrl: boolean; shift: boolean },
  ) => void;
  onPhotoOpen: (index: number) => void;
  onContextMenu: (e: React.MouseEvent, index: number) => void;
  virtualStart: number;
  searchQuery?: string;
}

export const PhotoRow = memo(function PhotoRow({
  photo,
  index,
  selected,
  thumbnails,
  imageMetadata,
  visibleColumns,
  draftEdits = {},
  onSelect,
  onPhotoOpen,
  onContextMenu,
  virtualStart,
  searchQuery = "",
}: RowProps) {
  const subscribeThumb = useCallback(
    (cb: () => void) => thumbnails.subscribe(photo.relative_path, cb),
    [thumbnails, photo.relative_path],
  );
  const getThumbSnapshot = useCallback(
    () => thumbnails.get(photo.relative_path),
    [thumbnails, photo.relative_path],
  );
  const thumbnail = useSyncExternalStore(subscribeThumb, getThumbSnapshot);

  const subscribeMeta = useCallback(
    (cb: () => void) => imageMetadata.subscribe(photo.relative_path, cb),
    [imageMetadata, photo.relative_path],
  );
  const getMetaSnapshot = useCallback(
    () => imageMetadata.get(photo.relative_path),
    [imageMetadata, photo.relative_path],
  );
  const metadata = useSyncExternalStore(subscribeMeta, getMetaSnapshot);

  const isLoading = thumbnail === "loading";
  const hasSrc = thumbnail !== "loading" && thumbnail !== "failed";
  const src = hasSrc ? `data:image/jpeg;base64,${thumbnail}` : null;

  const metadataLoading = metadata === "loading";
  const metadataFailed =
    metadata !== "loading" &&
    typeof metadata === "object" &&
    "_error" in metadata;

  const handleSelect = useCallback(
    (e: React.MouseEvent) =>
      onSelect(index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }),
    [onSelect, index],
  );
  const handleDoubleClick = useCallback(
    () => onPhotoOpen(index),
    [onPhotoOpen, index],
  );
  const handleContextMenuEvent = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, index),
    [onContextMenu, index],
  );

  const hasDrafts = Object.keys(draftEdits).length > 0;
  const rowClass = `photo-row ${index % 2 === 0 ? "photo-row--even" : "photo-row--odd"} ${selected ? "photo-row--selected" : ""}`;

  // Index of the first image-metadata cell â€” used to place exactly one spinner
  // per row while metadata is loading (per-cell spinners were O(rows Ã— cols)).
  const firstImageIdx = visibleColumns.findIndex((c) => c.kind === "image");

  return (
    <div
      className={rowClass}
      data-testid="photo-row"
      data-path={photo.relative_path}
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
        <div className="photo-thumb">
          {src ? (
            <img src={src} alt="" className="photo-thumb-img" />
          ) : isLoading ? (
            <div className="photo-thumb-spinner">
              <Spinner className="photo-thumb-spin-inner" />
            </div>
          ) : (
            <div className="photo-thumb-placeholder" />
          )}
        </div>
      </div>
      <div
        className="grid-cell grid-cell-path"
        data-col="relative_path"
        data-testid="photo-path"
      >
        <div
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span className="photo-cell-text">
            <CellContent
              text={photo.relative_path}
              draft={draftEdits["relative_path"]}
              searchQuery={searchQuery}
            />
          </span>
        </div>
        {hasDrafts && (
          <span
            className="row-draft-badge"
            title={`${Object.keys(draftEdits).length} pending edit(s)`}
          >
            {Object.keys(draftEdits).length} draft edit
            {Object.keys(draftEdits).length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {visibleColumns.map((col, i) => {
        if (col.kind === "os") {
          const testId =
            col.key === "date_modified"
              ? "photo-date-modified"
              : col.key === "date_created"
                ? "photo-date-created"
                : undefined;
          return (
            <div
              key={col.key}
              className="grid-cell grid-cell-date"
              data-col={col.key}
              data-testid={testId}
            >
              <CellContent
                text={formatPhotoRowDate(osValue(photo, col.key))}
                draft={draftEdits[col.key]}
                searchQuery={searchQuery}
              />
            </div>
          );
        }
        return (
          <div
            key={col.key}
            className="grid-cell grid-cell-metadata"
            data-col={col.key}
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
                  â€”
                </span>
              )
            ) : metadataFailed ? (
              <span className="metadata-error" title="Failed to load metadata">
                âœ—
              </span>
            ) : (
              <CellContent
                text={formatMetadataValue(metadata[col.key])}
                draft={draftEdits[col.key]}
                searchQuery={searchQuery}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

import { useState, useEffect, useRef, useMemo, useSyncExternalStore, useCallback } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi, type MediaLibraryActions } from "./useMediaLibrary";
import { ThumbnailStore, ImageMetadataStore } from "./types";
import type { AppState } from "./types";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import { GalleryView } from "./components/GalleryView";
import { StatusFooter } from "./components/StatusFooter";
import { ColumnSelectionDialog } from "./components/ColumnSelectionDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import { sortPhotos, shouldSuspendSorting } from "./utils/sorting";
import { filterPhotosForListSearch } from "./utils/listSearchFilter";
import { listSearchQueryIsActive } from "./utils/listSearchText";
import "./App.css";

const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload)),
};

async function loadImage(path: string): Promise<string | null> {
  try { return convertFileSrc(path); }
  catch { return null; }
}

// Separated component so useMemo can depend on loaded state without conditional hooks.
type LoadedState = Extract<AppState, { kind: "loaded" }> & { recentFolders: string[] };

function LoadedView({
  state,
  actions,
  showColumnDialog,
  setShowColumnDialog,
}: {
  state: LoadedState;
  actions: MediaLibraryActions;
  showColumnDialog: boolean;
  setShowColumnDialog: (v: boolean) => void;
}) {
  // Subscribe to metadata progress so sorting unblocks once metadata loading
  // completes, not just when the directory walk finishes.  Keeps re-renders
  // here cheap — getRemaining() returns a number and the store batches
  // notifications via queueMicrotask.
  const metadataProgress = state.metadataProgress;
  const metadataRemaining = useSyncExternalStore(
    metadataProgress.subscribe.bind(metadataProgress),
    metadataProgress.getSnapshot().bind(metadataProgress),
  );

  const sortingDisabled = shouldSuspendSorting(state.scanning, state.sortConfig, metadataRemaining);

  // We show photos in arrival order whenever sorting is suspended — both
  // during the directory walk and (for image-metadata sorts) while ExifTool
  // is still streaming results.  Without this gate, an active image-column
  // sort would re-run on every metadata batch (~50–125 full sorts per scan).
  const sortedPhotos = useMemo(
    () => sortingDisabled
      ? state.photos
      : sortPhotos(state.photos, state.sortConfig, state.imageMetadata),
    // metadataVersion is the invalidation signal for image-metadata sorts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.photos, state.sortConfig, state.metadataVersion, state.imageMetadata, sortingDisabled],
  );

  const [listSearchQuery, setListSearchQuery] = useState("");

  useEffect(() => {
    setListSearchQuery("");
  }, [state.folder]);

  const displayPhotos = useMemo(
    () => filterPhotosForListSearch(sortedPhotos, listSearchQuery, state.imageMetadata),
    // metadataVersion: hidden metadata can start matching after ExifTool results arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sortedPhotos, listSearchQuery, state.imageMetadata, state.metadataVersion],
  );

  useEffect(() => {
    const len = displayPhotos.length;
    if (state.selectedIndex !== null && state.selectedIndex >= len) {
      actions.selectPhoto(null);
    }
    if (state.galleryIndex !== null && (len === 0 || state.galleryIndex >= len)) {
      actions.closeGallery();
    }
  }, [displayPhotos.length, state.selectedIndex, state.galleryIndex, actions]);

  const onShowInExplorer = useCallback(
    async (index: number) => {
      const photo = displayPhotos[index];
      if (!photo) return;
      await invoke("show_in_explorer", {
        folder: state.folder,
        relativePath: photo.relative_path,
      });
    },
    [displayPhotos, state.folder],
  );

  const onGalleryNavigate = useCallback(
    (delta: -1 | 1) => {
      actions.navigateGallery(delta, { listLength: displayPhotos.length });
    },
    [actions, displayPhotos.length],
  );

  const listSearchActive = listSearchQueryIsActive(listSearchQuery);
  const emptySearchMessage =
    listSearchActive && sortedPhotos.length > 0 && displayPhotos.length === 0
      ? "No photos match your search."
      : null;

  return (
    <>
      <ErrorBanner errors={state.workerErrors} onDismiss={actions.dismissError} />
      <MenuBar
        photoCount={displayPhotos.length}
        photoCountTotal={listSearchActive ? sortedPhotos.length : undefined}
        scanning={state.scanning}
        metadataProgress={state.metadataProgress}
        onOpenFolder={actions.openFolder}
        onCloseFolder={actions.closeFolder}
        onSelectColumns={() => setShowColumnDialog(true)}
      />
      <div className="list-search-bar" data-testid="list-search-bar">
        <label className="list-search-label" htmlFor="list-search-input">
          Search
        </label>
        <input
          id="list-search-input"
          type="search"
          className="list-search-input"
          data-testid="list-search-input"
          placeholder="Path, file dates, image metadata…"
          value={listSearchQuery}
          onChange={(e) => setListSearchQuery(e.target.value)}
          aria-label="Search photos"
        />
      </div>
      <PhotoList
        photos={displayPhotos}
        thumbnails={state.thumbnails}
        imageMetadata={state.imageMetadata}
        visibleColumns={state.visibleColumns}
        columnWidths={state.columnWidths}
        onColumnWidthChange={actions.updateColumnWidth}
        onColumnsReorder={actions.setVisibleColumns}
        sortConfig={state.sortConfig}
        onSortChange={actions.setSortConfig}
        sortingDisabled={sortingDisabled}
        selectedIndex={state.selectedIndex}
        onSelect={actions.selectPhoto}
        onShowInExplorer={onShowInExplorer}
        onVisibilityChange={actions.prioritizeQueues}
        onPhotoOpen={actions.openGallery}
        onSelectColumns={() => setShowColumnDialog(true)}
        searchQuery={listSearchQuery}
        emptySearchMessage={emptySearchMessage}
      />
      {state.galleryIndex !== null && displayPhotos.length > 0 && (
        <GalleryView
          photos={displayPhotos}
          currentIndex={state.galleryIndex}
          folderPath={state.folder}
          onClose={actions.closeGallery}
          onNavigate={onGalleryNavigate}
          loadImage={loadImage}
          imageMetadata={state.imageMetadata}
        />
      )}
      {showColumnDialog && (
        <ColumnSelectionDialog
          allKeys={Array.from(state.imageMetadata.getKeyFrequency().entries()).map(([key, count]) => ({ key, count }))}
          visibleColumns={state.visibleColumns}
          onSave={(cols, resetWidths) => {
            actions.setVisibleColumns(cols);
            if (resetWidths) actions.resetColumnWidths();
            setShowColumnDialog(false);
          }}
          onClose={() => setShowColumnDialog(false)}
        />
      )}
      {state.scanning && <StatusFooter message="Discovering files…" />}
    </>
  );
}

export default function App() {
  const [state, actions] = useMediaLibrary(tauriApi);
  const [showColumnDialog, setShowColumnDialog] = useState(false);
  const [cliFolder, setCliFolder] = useState<string | null | undefined>(undefined);
  const cliCheckedRef = useRef(false);

  // Check for CLI folder argument on mount (before first render)
  useEffect(() => {
    if (cliCheckedRef.current) return;
    cliCheckedRef.current = true;

    invoke<string | null>("get_cli_folder")
      .then((folder) => {
        setCliFolder(folder);
        if (folder) {
          console.log("[App] Opening folder from CLI argument:", folder);
          actions.openRecent(folder);
        }
      })
      .catch((err) => {
        console.error("[App] Failed to get CLI folder:", err);
        setCliFolder(null);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showWelcome = state.kind === "idle" && cliFolder !== undefined;
  const checkingCli = cliFolder === undefined;

  return (
    <div className="app">
      {checkingCli && (
        <>
          <div style={{ flex: 1 }} />
          <StatusFooter message="Starting…" />
        </>
      )}

      {!checkingCli && showWelcome && (
        <WelcomeScreen
          onOpenFolder={actions.openFolder}
          recentFolders={state.recentFolders}
          onOpenRecent={actions.openRecent}
        />
      )}

      {!checkingCli && state.kind === "loading" && (
        <>
          <MenuBar
            photoCount={0}
            scanning={true}
            metadataProgress={null}
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
            onSelectColumns={() => setShowColumnDialog(true)}
          />
          <PhotoList
            photos={[]}
            thumbnails={new ThumbnailStore()}
            imageMetadata={new ImageMetadataStore()}
            visibleColumns={state.visibleColumns}
            columnWidths={state.columnWidths}
            sortConfig={state.sortConfig}
            onSortChange={() => {}}
            selectedIndex={null}
            onSelect={() => {}}
            onShowInExplorer={() => Promise.resolve()}
            onVisibilityChange={() => {}}
            onPhotoOpen={() => {}}
            onSelectColumns={() => setShowColumnDialog(true)}
          />
          <StatusFooter message="Discovering files…" />
        </>
      )}

      {!checkingCli && state.kind === "loaded" && (
        <LoadedView
          state={state as LoadedState}
          actions={actions}
          showColumnDialog={showColumnDialog}
          setShowColumnDialog={setShowColumnDialog}
        />
      )}
    </div>
  );
}

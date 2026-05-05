import { useState, useEffect, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
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
import { sortPhotos } from "./utils/sorting";
import { DEFAULT_COLUMNS, DEFAULT_OS_COLUMNS } from "./utils/columnConfig";
import "./App.css";

const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload)),
};

async function loadImage(path: string): Promise<string | null> {
  try { return await invoke<string>("load_image", { path }); }
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
  const sortedPhotos = useMemo(
    () => sortPhotos(state.photos, state.sortConfig, state.imageMetadata),
    // metadataVersion is the invalidation signal for image-metadata sorts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.photos, state.sortConfig, state.metadataVersion, state.imageMetadata],
  );

  return (
    <>
      <ErrorBanner errors={state.workerErrors} onDismiss={actions.dismissError} />
      <MenuBar
        photoCount={state.photos.length}
        scanning={state.scanning}
        metadataProgress={state.metadataProgress}
        onOpenFolder={actions.openFolder}
        onCloseFolder={actions.closeFolder}
        onSelectColumns={() => setShowColumnDialog(true)}
      />
      <PhotoList
        photos={sortedPhotos}
        thumbnails={state.thumbnails}
        imageMetadata={state.imageMetadata}
        visibleColumns={state.visibleColumns}
        visibleOSColumns={state.visibleOSColumns}
        columnWidths={state.columnWidths}
        onColumnWidthChange={actions.updateColumnWidth}
        onColumnsReorder={actions.setVisibleColumns}
        onOSColumnsReorder={actions.setVisibleOSColumns}
        sortConfig={state.sortConfig}
        onSortChange={actions.setSortConfig}
        selectedIndex={state.selectedIndex}
        onSelect={actions.selectPhoto}
        onShowInExplorer={actions.showInExplorer}
        onVisibilityChange={actions.prioritizeQueues}
        onPhotoOpen={actions.openGallery}
        onSelectColumns={() => setShowColumnDialog(true)}
      />
      {state.galleryIndex !== null && (
        <GalleryView
          photos={sortedPhotos}
          currentIndex={state.galleryIndex}
          folderPath={state.folder}
          onClose={actions.closeGallery}
          onNavigate={actions.navigateGallery}
          loadImage={loadImage}
        />
      )}
      {showColumnDialog && (
        <ColumnSelectionDialog
          allKeys={Array.from(state.imageMetadata.getKeyFrequency().entries()).map(([key, count]) => ({ key, count }))}
          visibleColumns={state.visibleColumns}
          visibleOSColumns={state.visibleOSColumns}
          onSave={(cols, osCols) => {
            actions.setVisibleColumns(cols);
            actions.setVisibleOSColumns(osCols);
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
            visibleColumns={DEFAULT_COLUMNS}
            visibleOSColumns={DEFAULT_OS_COLUMNS}
            sortConfig={{ primary: null, secondary: null }}
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

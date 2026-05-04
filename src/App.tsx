import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi } from "./useMediaLibrary";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import { GalleryView } from "./components/GalleryView";
import { StatusFooter } from "./components/StatusFooter";
import { ColumnSelectionDialog } from "./components/ColumnSelectionDialog";
import "./App.css";

const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload)),
};

async function loadImage(path: string): Promise<string | null> {
  try { return await invoke<string>("load_image", { path }); }
  catch { return null; }
}

export default function App() {
  const [state, actions] = useMediaLibrary(tauriApi);
  const [showColumnDialog, setShowColumnDialog] = useState(false);
  const [cliHandled, setCliHandled] = useState(false);

  // Check for CLI folder argument on mount
  useEffect(() => {
    if (cliHandled) return;
    
    invoke<string | null>("get_cli_folder").then((folder) => {
      if (folder) {
        console.log("[App] Opening folder from CLI argument:", folder);
        actions.openRecent(folder);
        setCliHandled(true);
      }
    }).catch((err) => {
      console.error("[App] Failed to get CLI folder:", err);
    });
  }, [cliHandled, actions]);

  // Show the footer whenever the directory walk is still running.
  const isDiscovering =
    state.kind === "loading" ||
    (state.kind === "loaded" && state.scanning);

  return (
    <div className="app">
      {state.kind === "idle" && (
        <WelcomeScreen
          onOpenFolder={actions.openFolder}
          recentFolders={state.recentFolders}
          onOpenRecent={actions.openRecent}
        />
      )}

      {state.kind === "loading" && (
        // Show an empty list shell while waiting for the first photo.
        // The footer below will show "Discovering files…".
        <>
          <div style={{ flex: 1 }} />
          <StatusFooter message="Discovering files…" />
        </>
      )}

      {state.kind === "loaded" && (
        <>
          <MenuBar
            photoCount={state.photos.length}
            scanning={state.scanning}
            metadataProgress={state.metadataProgress}
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
            onSelectColumns={() => setShowColumnDialog(true)}
          />
          <PhotoList
            photos={state.photos}
            thumbnails={state.thumbnails}
            imageMetadata={state.imageMetadata}
            visibleColumns={state.visibleColumns}
            selectedIndex={state.selectedIndex}
            onSelect={actions.selectPhoto}
            onShowInExplorer={actions.showInExplorer}
            onVisibilityChange={actions.prioritizeQueues}
            onPhotoOpen={actions.openGallery}
          />
          {state.galleryIndex !== null && (
            <GalleryView
              photos={state.photos}
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
              onSave={(cols) => {
                actions.setVisibleColumns(cols);
                setShowColumnDialog(false);
              }}
              onClose={() => setShowColumnDialog(false)}
            />
          )}
          
          {state.scanning && (
            <StatusFooter message="Discovering files…" />
          )}
        </>
      )}
    </div>
  );
}

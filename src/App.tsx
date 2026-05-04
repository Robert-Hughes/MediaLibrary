import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi } from "./useMediaLibrary";
import { ThumbnailStore, ImageMetadataStore } from "./types";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import { GalleryView } from "./components/GalleryView";
import { StatusFooter } from "./components/StatusFooter";
import { ColumnSelectionDialog } from "./components/ColumnSelectionDialog";
import { ErrorBanner } from "./components/ErrorBanner";
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
  const [cliFolder, setCliFolder] = useState<string | null | undefined>(undefined);
  const cliCheckedRef = useRef(false);

  // Check for CLI folder argument on mount (before first render)
  useEffect(() => {
    if (cliCheckedRef.current) return; // Already checked
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
  }, []); // Empty deps - only run once

  // Don't render welcome screen until we've checked for CLI folder
  // This prevents a flicker when opening via CLI argument
  const showWelcome = state.kind === "idle" && cliFolder !== undefined;
  const checkingCli = cliFolder === undefined;

  return (
    <div className="app">
      {checkingCli && (
        // Show loading while checking for CLI folder argument
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
        // Show table headers immediately while waiting for the first photo.
        // The footer below will show "Discovering files…".
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
            visibleColumns={[
              "ExifIFD:DateTimeOriginal",
              "XMP-dc:Description", 
              "XMP-dc:Subject",
              "GPS:GPSLatitude",
              "GPS:GPSLongitude",
              "XMP-iptcCore:Location",
              "XMP-photoshop:City",
              "XMP-photoshop:State",
              "XMP-photoshop:Country",
            ]}
            selectedIndex={null}
            onSelect={() => {}}
            onShowInExplorer={() => Promise.resolve()}
            onVisibilityChange={() => {}}
            onPhotoOpen={() => {}}
          />
          <StatusFooter message="Discovering files…" />
        </>
      )}

      {!checkingCli && state.kind === "loaded" && (
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

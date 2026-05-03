import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi } from "./useMediaLibrary";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import { GalleryView } from "./components/GalleryView";
import { StatusFooter } from "./components/StatusFooter";
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

  // Show the footer whenever the directory walk is still running.
  const isDiscovering =
    state.kind === "loading" ||
    (state.kind === "loaded" && state.scanning);

  return (
    <div className="app">
      {state.kind === "idle" && (
        <WelcomeScreen onOpenFolder={actions.openFolder} />
      )}

      {state.kind === "loading" && (
        // Show an empty list shell while waiting for the first photo.
        // The footer below will show "Discovering files…".
        <div style={{ flex: 1 }} />
      )}

      {state.kind === "loaded" && (
        <>
          <MenuBar
            photoCount={state.photos.length}
            scanning={state.scanning}
            metadataLoading={state.metadataRemaining > 0}
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
          />
          <PhotoList
            photos={state.photos}
            thumbnails={state.thumbnails}
            metadata={state.metadata}
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
        </>
      )}

      {isDiscovering && (
        <StatusFooter message="Discovering files…" />
      )}
    </div>
  );
}

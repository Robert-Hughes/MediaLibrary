import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi } from "./useMediaLibrary";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import { GalleryView } from "./components/GalleryView";
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

  return (
    <div className="app">
      {state.kind === "idle" && (
        <WelcomeScreen onOpenFolder={actions.openFolder} />
      )}

      {/* Loading: show a simple spinner while waiting for the first photo */}
      {state.kind === "loading" && (
        <LoadingScreen folder={state.folder} foundSoFar={0} />
      )}

      {state.kind === "loaded" && (
        <>
          <MenuBar
            photoCount={state.photos.length}
            scanning={state.scanning}
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
          />
          <PhotoList
            photos={state.photos}
            thumbnails={state.thumbnails}
            metadata={state.metadata}
            scanning={state.scanning}
            onVisibilityChange={actions.prioritizeThumbnails}
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
    </div>
  );
}

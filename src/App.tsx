import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi } from "./useMediaLibrary";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { Toolbar } from "./components/Toolbar";
import { PhotoList } from "./components/PhotoList";
import "./App.css";

// Wire up the real Tauri IPC implementation.
const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) =>
    listen(event, (e) => handler(e.payload)),
};

export default function App() {
  const [state, actions] = useMediaLibrary(tauriApi);

  // Space bar shortcut to open folder (only when not already loading).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && state.kind !== "loading") {
        e.preventDefault();
        actions.openFolder();
      }
      if (e.code === "Escape" && state.kind === "loaded") {
        actions.closeFolder();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state.kind, actions]);

  return (
    <div className="app">
      {state.kind === "idle" && (
        <WelcomeScreen onOpenFolder={actions.openFolder} />
      )}

      {state.kind === "loading" && (
        <LoadingScreen folder={state.folder} foundSoFar={state.foundSoFar} />
      )}

      {state.kind === "loaded" && (
        <>
          <Toolbar
            folder={state.folder}
            photoCount={state.photos.length}
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
          />
          <PhotoList photos={state.photos} thumbnails={state.thumbnails} onVisibilityChange={actions.prioritizeThumbnails} />
        </>
      )}
    </div>
  );
}

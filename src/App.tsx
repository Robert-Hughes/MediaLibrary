import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useMediaLibrary, type TauriApi } from "./useMediaLibrary";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { LoadingScreen } from "./components/LoadingScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import "./App.css";

const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) =>
    listen(event, (e) => handler(e.payload)),
};

export default function App() {
  const [state, actions] = useMediaLibrary(tauriApi);

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
          <MenuBar
            photoCount={state.photos.length}
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
          />
          <PhotoList
            photos={state.photos}
            thumbnails={state.thumbnails}
            onVisibilityChange={actions.prioritizeThumbnails}
          />
        </>
      )}
    </div>
  );
}

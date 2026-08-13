import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useSyncExternalStore,
  useCallback,
} from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useMediaLibrary,
  type TauriApi,
  type MediaLibraryActions,
} from "./useMediaLibrary";
import { ThumbnailStore, FileMetadataOccurrencesStore } from "./types";
import type { AppState } from "./types";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MenuBar } from "./components/MenuBar";
import { FileList, type FileListSelectionHandle } from "./components/FileList";
import { GalleryView } from "./components/GalleryView";
import { FullMapView } from "./components/FullMapView";
import { StatusBar } from "./components/StatusBar";
import { ColumnSelectionDialog } from "./components/ColumnSelectionDialog";
import { BulkMetadataEditorDialog } from "./components/BulkMetadataEditorDialog";
import { ApplyProgressDialog } from "./components/ApplyProgressDialog";
import { ModalDialog } from "./components/ModalDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsDialog } from "./components/SettingsDialog";
import { DescribeProgressDialog } from "./components/DescribeProgressDialog";
import { useDescribeImages } from "./hooks/useDescribeImages";
import { GeocodeProgressDialog } from "./components/GeocodeProgressDialog";
import { useGeocodeImages } from "./hooks/useGeocodeImages";
import { buildGeocodeRequestItemForFile } from "./utils/effectiveGps";
import type { GeocodeRequestItem } from "./types";
import { ALL_NORMALISE_GROUPS } from "./types";
import { NormaliseProgressDialog } from "./components/NormaliseProgressDialog";
import { useNormaliseMetadata } from "./hooks/useNormaliseMetadata";
import {
  countDescribeOverwrites,
  countGeocodeOverwrites,
  type OverwriteCount,
} from "./utils/countOverwrites";
import {
  buildNormaliseItems,
  metadataOccurrencesStoreLookup,
} from "./utils/buildNormaliseItems";
import { sortFiles, shouldSuspendSorting } from "./utils/sorting";
import { listSearchQueryIsActive } from "./utils/listSearchText";
import { computeEffectiveMetadataKeyFrequency } from "./utils/metadataKeyFrequency";
import { arePathsImageOnly } from "./utils/mediaKind";
import { useSearchService } from "./hooks/useSearchService";
import { parseSearchQuery } from "./search/searchQuery";
import "./App.css";

const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload)),
};

async function loadMedia(path: string): Promise<string | null> {
  try {
    return convertFileSrc(path);
  } catch {
    return null;
  }
}

// Separated component so useMemo can depend on loaded state without conditional hooks.
type LoadedState = Extract<AppState, { kind: "loaded" }> & {
  recentFolders: string[];
};

function LoadedView({
  state,
  actions,
  showColumnDialog,
  setShowColumnDialog,
  onOpenSettings,
  describe,
  geocode,
  normalise,
  setDescribeOverwrite,
  setGeocodeOverwrite,
}: {
  state: LoadedState;
  actions: MediaLibraryActions;
  showColumnDialog: boolean;
  setShowColumnDialog: (v: boolean) => void;
  onOpenSettings: () => void;
  describe: ReturnType<typeof useDescribeImages>;
  geocode: ReturnType<typeof useGeocodeImages>;
  normalise: ReturnType<typeof useNormaliseMetadata>;
  setDescribeOverwrite: (info: OverwriteCount) => void;
  setGeocodeOverwrite: (info: OverwriteCount) => void;
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

  const sortingDisabled = shouldSuspendSorting(
    state.scanning,
    state.sortConfig,
    metadataRemaining,
  );

  // We show files in arrival order whenever sorting is suspended — both
  // during the directory walk and (for image-metadata sorts) while ExifTool
  // is still streaming results.  Without this gate, an active image-column
  // sort would re-run on every metadata batch (~50–125 full sorts per scan).
  const sortedFiles = useMemo(
    () =>
      sortingDisabled
        ? state.files
        : sortFiles(
            state.files,
            state.sortConfig,
            state.fileMetadataOccurrences,
          ),
    // metadataVersion is the invalidation signal for image-metadata sorts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.files,
      state.sortConfig,
      state.metadataVersion,
      state.fileMetadataOccurrences,
      sortingDisabled,
    ],
  );

  const [listSearchQuery, setListSearchQuery] = useState("");
  const [selectionCount, setSelectionCount] = useState(0);
  const fileListSelectionRef = useRef<FileListSelectionHandle>(null);
  const [fullMapPaths, setFullMapPaths] = useState<string[] | null>(null);
  const [bulkEditPaths, setBulkEditPaths] = useState<string[] | null>(null);

  useEffect(() => {
    setListSearchQuery("");
    setFullMapPaths(null);
    setBulkEditPaths(null);
  }, [state.folder]);

  useEffect(() => {
    const active = new Set(state.files.map((file) => file.relative_path));
    setFullMapPaths((paths) => {
      if (paths === null) return null;
      const retained = paths.filter((path) => active.has(path));
      return retained.length > 0 ? retained : null;
    });
    setBulkEditPaths((paths) => {
      if (paths === null) return null;
      const retained = paths.filter((path) => active.has(path));
      return retained.length > 0 ? retained : null;
    });
  }, [state.files]);

  // Ctrl/Cmd+F focuses the relevant search box.  When the gallery's
  // details pane is visible its in-pane search is the right target;
  // otherwise the main list-view search box.  Both inputs use stable
  // ids so a DOM lookup is enough — no need to thread refs through the
  // component tree.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "f" && e.key !== "F") return;
      const details = document.getElementById(
        "details-search-input",
      ) as HTMLInputElement | null;
      const list = document.getElementById(
        "list-search-input",
      ) as HTMLInputElement | null;
      const target = details ?? list;
      if (!target) return;
      e.preventDefault();
      target.focus();
      target.select();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // Search is maintained from the Rust-authoritative session. The frontend
  // submits only the active query and filters its existing sorted list by the
  // returned relative-path set.
  const { matched: searchMatched, pending: searchPending } = useSearchService({
    sessionId: state.kind === "loaded" ? state.sessionId : null,
    query: listSearchQuery,
  });
  const parsedListSearchQuery = useMemo(
    () => parseSearchQuery(listSearchQuery),
    [listSearchQuery],
  );

  const displayFiles = useMemo(() => {
    if (searchMatched === null) return sortedFiles;
    return sortedFiles.filter((p) => searchMatched.has(p.relative_path));
  }, [sortedFiles, searchMatched]);
  const bulkEditFiles = useMemo(() => {
    if (bulkEditPaths === null) return [];
    const byPath = new Map(
      state.files.map((file) => [file.relative_path, file]),
    );
    return bulkEditPaths.flatMap((path) => {
      const file = byPath.get(path);
      return file ? [file] : [];
    });
  }, [bulkEditPaths, state.files]);

  const galleryIndex = useMemo(
    () =>
      state.galleryPath === null
        ? -1
        : displayFiles.findIndex(
            (file) => file.relative_path === state.galleryPath,
          ),
    [displayFiles, state.galleryPath],
  );

  useEffect(() => {
    if (
      state.selectedPath !== null &&
      !displayFiles.some((file) => file.relative_path === state.selectedPath)
    ) {
      actions.selectFile(null);
    }
    if (state.galleryPath !== null && galleryIndex < 0) {
      actions.closeGallery();
    }
  }, [
    displayFiles,
    galleryIndex,
    state.selectedPath,
    state.galleryPath,
    actions,
  ]);

  const onShowInExplorer = useCallback(
    async (index: number) => {
      const file = displayFiles[index];
      if (!file) return;
      await invoke("show_in_explorer", {
        folder: state.folder,
        relativePath: file.relative_path,
      });
    },
    [displayFiles, state.folder],
  );

  const onCopyPaths = useCallback(
    async (relativePaths: string[]) => {
      if (relativePaths.length === 0) return;
      const folder = state.folder;
      if (!folder) return;
      const sep = folder.includes("\\") ? "\\" : "/";
      const base = folder.replace(/[\\/]+$/, "");
      const abs = relativePaths
        .map((p) => base + sep + p.replace(/[\\/]+/g, sep))
        .join("\n");
      await navigator.clipboard.writeText(abs);
    },
    [state.folder],
  );

  const onGalleryNavigate = useCallback(
    (delta: -1 | 1) => {
      if (galleryIndex < 0) return;
      const nextIndex = Math.max(
        0,
        Math.min(displayFiles.length - 1, galleryIndex + delta),
      );
      const nextFile = displayFiles[nextIndex];
      if (nextFile) actions.openGallery(nextFile.relative_path);
    },
    [actions, displayFiles, galleryIndex],
  );

  const listSearchActive = listSearchQueryIsActive(listSearchQuery);
  const emptySearchMessage =
    listSearchActive && sortedFiles.length > 0 && displayFiles.length === 0
      ? "No files match your search."
      : null;

  const draftCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [path, edits] of Object.entries(state.targetDraftEdits)) {
      counts[path] = Object.keys(edits).length;
    }
    return counts;
  }, [state.targetDraftEdits]);

  const draftEditsSummary = useMemo(() => {
    const entries = Object.values(draftCounts).filter((count) => count > 0);
    return entries.length > 0
      ? { files: entries.length, edits: entries.reduce((a, b) => a + b, 0) }
      : null;
  }, [draftCounts]);

  const columnDialogAllKeys = useMemo(() => {
    if (!showColumnDialog) return [];
    // These revisions invalidate reads from stores that mutate in place while
    // metadata is streaming, even though the store objects remain stable.
    void state.metadataVersion;
    void metadataRemaining;
    return computeEffectiveMetadataKeyFrequency(
      state.files,
      state.fileMetadataOccurrences,
      state.targetDraftEdits,
    );
  }, [
    showColumnDialog,
    state.files,
    state.fileMetadataOccurrences,
    state.targetDraftEdits,
    state.metadataVersion,
    metadataRemaining,
  ]);

  const onClickDraftSummary = useCallback(() => {
    setListSearchQuery("has:edits");
  }, []);

  /**
   * Resolve the GPS payload for a set of rel-paths into the shape
   * the geocode_files_cmd expects. The frontend owns the
   * "drafts win over metadata" precedence so the backend never has
   * to read the typed-draft store. See docs/REVERSE_GEOCODE_PLAN.md
   * §2. Items with no GPS are still included with `lat`/`lon` null —
   * the backend surfaces them as `no_gps` failures so the user sees
   * the breakdown in the done panel rather than silently dropping
   * them at the call site.
   */
  const buildGeocodeItems = useCallback(
    (relPaths: string[]): GeocodeRequestItem[] => {
      return relPaths.map((relPath) =>
        buildGeocodeRequestItemForFile(relPath, {
          occurrences: state.fileMetadataOccurrences.get(relPath),
          targetDrafts: state.targetDraftEdits[relPath],
        }),
      );
    },
    [state.fileMetadataOccurrences, state.targetDraftEdits],
  );

  return (
    <>
      <ErrorBanner
        errors={state.applicationErrors}
        onDismiss={actions.dismissError}
      />
      <MenuBar
        onOpenFolder={actions.openFolder}
        onCloseFolder={actions.closeFolder}
        onSelectColumns={() => setShowColumnDialog(true)}
        onOpenSettings={onOpenSettings}
        searchQuery={listSearchQuery}
        onSearchQueryChange={setListSearchQuery}
        searching={searchPending}
      />
      <FileList
        ref={fileListSelectionRef}
        files={displayFiles}
        thumbnails={state.thumbnails}
        fileMetadataOccurrences={state.fileMetadataOccurrences}
        targetDraftEdits={state.targetDraftEdits}
        visibleColumns={state.visibleColumns}
        columnWidths={state.columnWidths}
        onColumnWidthChange={actions.updateColumnWidth}
        onColumnsReorder={actions.setVisibleColumns}
        sortConfig={state.sortConfig}
        onSortChange={actions.setSortConfig}
        sortingDisabled={sortingDisabled}
        selectedPath={state.selectedPath}
        onSelect={actions.selectFile}
        onShowInExplorer={onShowInExplorer}
        onVisibilityChange={actions.prioritizeQueues}
        onFileOpen={actions.openGallery}
        searchQuery={parsedListSearchQuery.freeText}
        emptySearchMessage={emptySearchMessage}
        onDiscardAllEdits={(paths) => actions.discardAllDraftEdits(paths)}
        onRecycleFiles={async (paths) => {
          await actions.recycleFiles(paths);
        }}
        onApplyEdits={(paths) => actions.applyDraftEdits(paths)}
        onGenerateAiDescription={(relPaths) => {
          if (!arePathsImageOnly(state.files, relPaths)) return;
          if (!actions.canStageGeneratedMetadata(relPaths)) return;
          setDescribeOverwrite(
            countDescribeOverwrites(
              relPaths,
              state.fileMetadataOccurrences,
              state.targetDraftEdits,
            ),
          );
          describe.actions.start(state.folder, relPaths);
        }}
        onGeocode={(relPaths) => {
          if (!actions.canStageGeneratedMetadata(relPaths)) return;
          setGeocodeOverwrite(
            countGeocodeOverwrites(
              relPaths,
              state.fileMetadataOccurrences,
              state.targetDraftEdits,
            ),
          );
          geocode.actions.start(state.folder, buildGeocodeItems(relPaths));
        }}
        onNormalise={(relPaths) => {
          if (!actions.canStageGeneratedMetadata(relPaths)) return;
          // Default enabled groups: every v1 group. User can untick
          // individual groups in the confirm dialog.
          const initialGroups = ALL_NORMALISE_GROUPS;
          normalise.actions.startFromPaths(
            state.folder,
            relPaths,
            [...initialGroups],
            () =>
              buildNormaliseItems(
                relPaths,
                metadataOccurrencesStoreLookup(state.fileMetadataOccurrences),
                state.targetDraftEdits,
                initialGroups,
              ),
          );
        }}
        onCopyPaths={onCopyPaths}
        onBulkEdit={(relativePaths) => {
          if (!actions.canOpenBulkMetadataEditor(relativePaths)) return;
          setBulkEditPaths([...relativePaths]);
        }}
        onShowOnMap={setFullMapPaths}
        onSelectionCountChange={setSelectionCount}
      />
      {bulkEditPaths !== null && bulkEditFiles.length > 0 && (
        <BulkMetadataEditorDialog
          key={bulkEditPaths.join("\n")}
          files={bulkEditFiles}
          fileMetadataOccurrences={state.fileMetadataOccurrences}
          targetDraftEdits={state.targetDraftEdits}
          onPreview={(request) =>
            actions.previewBulkMetadataDraftBatch(bulkEditPaths, request)
          }
          onStage={(request) =>
            actions.stageBulkMetadataDraftBatch(bulkEditPaths, request)
          }
          onClose={() => setBulkEditPaths(null)}
        />
      )}
      {state.galleryPath !== null && galleryIndex >= 0 && (
        <GalleryView
          files={displayFiles}
          currentIndex={galleryIndex}
          folderPath={state.folder}
          onClose={actions.closeGallery}
          onNavigate={onGalleryNavigate}
          loadMedia={loadMedia}
          fileMetadataOccurrences={state.fileMetadataOccurrences}
          targetDraftEdits={
            state.targetDraftEdits[displayFiles[galleryIndex].relative_path]
          }
          targetDraftPersistence={state.targetDraftPersistence}
          onSetExistingOccurrenceDraft={actions.setExistingOccurrenceDraft}
          onRemoveMetadataTargets={actions.removeMetadataTargets}
          onPreviewMetadataTargetRemovals={
            actions.previewMetadataTargetRemovals
          }
          onPreviewGpsTargetDraftBatch={actions.previewGpsTargetDraftBatch}
          onApplyGpsTargetDraftBatch={actions.applyGpsTargetDraftBatch}
          onSetNewPropertyDraft={actions.setNewPropertyDraft}
          onReplaceNewPropertyDraftTarget={
            actions.replaceNewPropertyDraftTarget
          }
          onDiscardTargetPropertyDraft={actions.discardTargetPropertyDraft}
          onDiscardTargetDraftBatch={actions.discardTargetDraftValues}
          onDiscardAllEdits={actions.discardAllDraftEdits}
          onApplyEdits={(path) => actions.applyDraftEdits(path)}
          onGenerateAiDescription={(relPath) => {
            if (!arePathsImageOnly(state.files, [relPath])) return;
            if (!actions.canStageGeneratedMetadata([relPath])) return;
            setDescribeOverwrite(
              countDescribeOverwrites(
                [relPath],
                state.fileMetadataOccurrences,
                state.targetDraftEdits,
              ),
            );
            describe.actions.start(state.folder, [relPath]);
          }}
          onGeocode={(relPath) => {
            if (!actions.canStageGeneratedMetadata([relPath])) return;
            setGeocodeOverwrite(
              countGeocodeOverwrites(
                [relPath],
                state.fileMetadataOccurrences,
                state.targetDraftEdits,
              ),
            );
            geocode.actions.start(state.folder, buildGeocodeItems([relPath]));
          }}
          onNormalise={(relPath) => {
            if (!actions.canStageGeneratedMetadata([relPath])) return;
            const initialGroups = ALL_NORMALISE_GROUPS;
            normalise.actions.startFromPaths(
              state.folder,
              [relPath],
              [...initialGroups],
              () =>
                buildNormaliseItems(
                  [relPath],
                  metadataOccurrencesStoreLookup(state.fileMetadataOccurrences),
                  state.targetDraftEdits,
                  initialGroups,
                ),
            );
          }}
          onShowInFileExplorer={(relPath) => {
            const idx = displayFiles.findIndex(
              (p) => p.relative_path === relPath,
            );
            if (idx >= 0) void onShowInExplorer(idx);
          }}
          onOpenFullMap={(relPath) => setFullMapPaths([relPath])}
          onRecycleFile={async (relPath) => {
            await actions.recycleFiles([relPath]);
          }}
        />
      )}
      {fullMapPaths && (
        <FullMapView
          relativePaths={fullMapPaths}
          files={state.files}
          thumbnails={state.thumbnails}
          fileMetadataOccurrences={state.fileMetadataOccurrences}
          targetDraftEdits={state.targetDraftEdits}
          onClose={() => setFullMapPaths(null)}
        />
      )}
      {showColumnDialog && (
        <ColumnSelectionDialog
          allKeys={columnDialogAllKeys}
          visibleColumns={state.visibleColumns}
          onSave={(cols, resetWidths) => {
            actions.setVisibleColumns(cols);
            if (resetWidths) actions.resetColumnWidths();
            setShowColumnDialog(false);
          }}
          onClose={() => setShowColumnDialog(false)}
        />
      )}
      {(state.applying || state.applyCompletion) && (
        <ApplyProgressDialog
          applying={state.applying}
          completion={state.applyCompletion ?? null}
          onCancel={actions.cancelApplyEdits}
          onClose={actions.dismissApplyCompletion}
          verificationOutcomes={state.targetVerifyOutcomes}
          onAcceptVerification={actions.acceptTargetVerifyOutcome}
          onKeepVerification={actions.keepTargetDraftAndDismissOutcome}
          onDiscardVerification={actions.discardTargetDraftAndOutcome}
        />
      )}
      <StatusBar
        fileCount={displayFiles.length}
        fileCountTotal={listSearchActive ? sortedFiles.length : undefined}
        scanning={state.scanning}
        metadataProgress={state.metadataProgress}
        selectedCount={selectionCount}
        onToggleFileSelection={() =>
          fileListSelectionRef.current?.toggleAllSelection()
        }
        draftEditsSummary={draftEditsSummary}
        onClickDraftSummary={onClickDraftSummary}
        onApplyAllEdits={() => actions.applyDraftEdits()}
        onDiscardAllEdits={() => actions.discardAllDraftEdits()}
      />
    </>
  );
}

let __appFirstRenderLogged = false;

export default function App() {
  if (!__appFirstRenderLogged) {
    __appFirstRenderLogged = true;
    const t0 =
      (window as unknown as { __startupT0?: number }).__startupT0 ?? Date.now();
    console.log(`[startup] App() first render begin +${Date.now() - t0}ms`);
  }
  const [state, actions] = useMediaLibrary(tauriApi);
  const [showColumnDialog, setShowColumnDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const [cliFolder, setCliFolder] = useState<string | null | undefined>(
    undefined,
  );
  const [schemaReady, setSchemaReady] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const cliCheckedRef = useRef(false);
  // Overwrite counts computed at flow-start time and shown as an inline
  // notice in each dialog's awaiting-confirm panel. Stored at App level
  // so the dialogs (which render at App scope) can read them. We never
  // need to clear these explicitly — the next `start` overwrites them
  // and the dialog only consults them while it's open.
  const [describeOverwrite, setDescribeOverwrite] = useState<
    OverwriteCount | undefined
  >(undefined);
  const [geocodeOverwrite, setGeocodeOverwrite] = useState<
    OverwriteCount | undefined
  >(undefined);
  const describe = useDescribeImages({
    sessionId: state.kind === "loaded" ? state.sessionId : undefined,
    operation:
      state.kind === "loaded" ? state.batchOperations.describe : undefined,
  });
  const geocode = useGeocodeImages({
    sessionId: state.kind === "loaded" ? state.sessionId : undefined,
    operation:
      state.kind === "loaded" ? state.batchOperations.geocode : undefined,
  });
  const normalise = useNormaliseMetadata({
    sessionId: state.kind === "loaded" ? state.sessionId : undefined,
    operation:
      state.kind === "loaded" ? state.batchOperations.normalise : undefined,
  });
  const confirmDescribe = () => {
    if (!actions.canStageGeneratedMetadata(describe.state.relPaths)) return;
    describe.actions.confirm();
  };
  const confirmGeocode = () => {
    const paths = geocode.state.items.map((item) => item.relPath);
    if (!actions.canStageGeneratedMetadata(paths)) return;
    geocode.actions.confirm();
  };
  const confirmNormalise = () => {
    const paths = normalise.state.items.map((item) => item.relPath);
    if (!actions.canStageGeneratedMetadata(paths)) return;
    normalise.actions.confirm();
  };

  useEffect(() => {
    const t0 =
      (window as unknown as { __startupT0?: number }).__startupT0 ?? Date.now();
    console.log(
      `[startup] App first commit (post-mount effect) +${Date.now() - t0}ms`,
    );
    requestAnimationFrame(() => {
      console.log(`[startup] first rAF after mount +${Date.now() - t0}ms`);
    });
  }, []);

  // Warm the tag-schema registry before the UI becomes interactive so editors
  // never see a missing-schema flash on first use.
  useEffect(() => {
    const t0 =
      (window as unknown as { __startupT0?: number }).__startupT0 ?? Date.now();
    console.log(
      `[startup] App useEffect (preload_schema invoke) +${Date.now() - t0}ms`,
    );
    const callStart = Date.now();
    invoke("preload_schema")
      .then(() => {
        console.log(
          `[startup] preload_schema resolved +${Date.now() - t0}ms (invoke took ${Date.now() - callStart}ms)`,
        );
        setSchemaReady(true);
      })
      .catch((err) => {
        console.error("[App] preload_schema failed:", err);
        setSchemaError(
          typeof err === "string"
            ? err
            : err instanceof Error
              ? err.message
              : String(err),
        );
      });
  }, []);

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
      {!schemaReady && !schemaError && (
        <ModalDialog
          open
          onDismiss={() => {}}
          dismissible={false}
          testId="schema-loading-dialog"
          aria-label="Loading schema"
        >
          <div className="dialog-content" style={{ width: 360 }}>
            <div className="dialog-header">
              <span className="dialog-title">Loading schema…</span>
            </div>
            <div className="dialog-body">
              <div className="dialog-hint">
                Loading the tag schema from ExifTool.
              </div>
            </div>
          </div>
        </ModalDialog>
      )}

      {schemaError && (
        <ModalDialog
          open
          onDismiss={() => {}}
          dismissible={false}
          testId="schema-error-dialog"
          aria-label="Failed to load tag schema"
        >
          <div className="dialog-content" style={{ width: 480 }}>
            <div className="dialog-header">
              <span className="dialog-title">Failed to load tag schema</span>
            </div>
            <div className="dialog-body">
              <div className="dialog-hint">
                Could not build the tag schema from ExifTool. Make sure
                <code> exiftool </code> is installed and available on your
                <code> PATH</code>, then restart the application.
              </div>
              <pre
                data-testid="schema-error-message"
                style={{
                  marginTop: 12,
                  padding: 8,
                  background: "var(--color-bg-subtle, #f5f5f5)",
                  border: "1px solid var(--color-border, #ddd)",
                  borderRadius: 4,
                  fontSize: 12,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 200,
                  overflow: "auto",
                }}
              >
                {schemaError}
              </pre>
            </div>
          </div>
        </ModalDialog>
      )}

      {checkingCli && <div style={{ flex: 1 }} />}

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
            onOpenFolder={actions.openFolder}
            onCloseFolder={actions.closeFolder}
            onSelectColumns={() => setShowColumnDialog(true)}
            onOpenSettings={() => setShowSettingsDialog(true)}
          />
          <FileList
            targetDraftEdits={{}}
            files={[]}
            thumbnails={new ThumbnailStore()}
            fileMetadataOccurrences={new FileMetadataOccurrencesStore()}
            visibleColumns={state.visibleColumns}
            columnWidths={state.columnWidths}
            sortConfig={state.sortConfig}
            onSortChange={() => {}}
            selectedPath={null}
            onSelect={() => {}}
            onShowInExplorer={() => Promise.resolve()}
            onVisibilityChange={() => {}}
            onFileOpen={() => {}}
            onSelectColumns={() => setShowColumnDialog(true)}
          />
          <StatusBar
            fileCount={0}
            scanning={true}
            metadataProgress={null}
            selectedCount={0}
          />
        </>
      )}

      {!checkingCli && state.kind === "loaded" && (
        <ErrorBoundary name="LoadedView">
          <LoadedView
            state={state as LoadedState}
            actions={actions}
            showColumnDialog={showColumnDialog}
            setShowColumnDialog={setShowColumnDialog}
            onOpenSettings={() => setShowSettingsDialog(true)}
            describe={describe}
            geocode={geocode}
            normalise={normalise}
            setDescribeOverwrite={setDescribeOverwrite}
            setGeocodeOverwrite={setGeocodeOverwrite}
          />
        </ErrorBoundary>
      )}

      {showSettingsDialog && (
        <SettingsDialog onClose={() => setShowSettingsDialog(false)} />
      )}

      {describe.open && (
        <DescribeProgressDialog
          state={describe.state}
          overwriteInfo={describeOverwrite}
          onConfirm={confirmDescribe}
          onCancel={describe.actions.cancel}
          onClose={describe.actions.close}
        />
      )}

      {geocode.open && (
        <GeocodeProgressDialog
          state={geocode.state}
          overwriteInfo={geocodeOverwrite}
          onConfirm={confirmGeocode}
          onCancel={geocode.actions.cancel}
          onClose={geocode.actions.close}
        />
      )}

      {normalise.open && (
        <NormaliseProgressDialog
          state={normalise.state}
          onConfirm={confirmNormalise}
          onCancel={normalise.actions.cancel}
          onClose={normalise.actions.close}
          onSetEnabledGroups={normalise.actions.setEnabledGroups}
        />
      )}
    </div>
  );
}

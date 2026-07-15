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
import { ThumbnailStore, ImageMetadataStore } from "./types";
import type { AppState } from "./types";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { MenuBar } from "./components/MenuBar";
import { PhotoList } from "./components/PhotoList";
import { GalleryView } from "./components/GalleryView";
import { StatusBar } from "./components/StatusBar";
import { ColumnSelectionDialog } from "./components/ColumnSelectionDialog";
import { ApplyProgressDialog } from "./components/ApplyProgressDialog";
import { VerifyOutcomeDialog } from "./components/VerifyOutcomeDialog";
import { TargetVerifyOutcomeDialog } from "./components/TargetVerifyOutcomeDialog";
import { ModalDialog } from "./components/ModalDialog";
import { ErrorBanner } from "./components/ErrorBanner";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { SettingsDialog } from "./components/SettingsDialog";
import { DescribeProgressDialog } from "./components/DescribeProgressDialog";
import { useDescribeImages } from "./hooks/useDescribeImages";
import { GeocodeProgressDialog } from "./components/GeocodeProgressDialog";
import { useGeocodeImages } from "./hooks/useGeocodeImages";
import { buildGeocodeRequestItemForFile } from "./utils/effectiveGps";
import { schemaDefinitionIdToken } from "./utils/schemaDefinitionId";
import type { GeocodeRequestItem, MetadataDraftEntry } from "./types";
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
  metadataStoreLookup,
} from "./utils/buildNormaliseItems";
import { sortPhotos, shouldSuspendSorting } from "./utils/sorting";
import { listSearchQueryIsActive } from "./utils/listSearchText";
import { computeEffectiveMetadataKeyFrequency } from "./utils/metadataKeyFrequency";
import { verificationDialogToShow } from "./utils/verificationDialogPolicy";
import { useSearchWorker, createSearchWorker } from "./hooks/useSearchWorker";
import "./App.css";

const tauriApi: TauriApi = {
  invoke: (cmd, args) => invoke(cmd, args),
  listen: (event, handler) => listen(event, (e) => handler(e.payload)),
};

async function loadImage(path: string): Promise<string | null> {
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

  // We show photos in arrival order whenever sorting is suspended — both
  // during the directory walk and (for image-metadata sorts) while ExifTool
  // is still streaming results.  Without this gate, an active image-column
  // sort would re-run on every metadata batch (~50–125 full sorts per scan).
  const sortedPhotos = useMemo(
    () =>
      sortingDisabled
        ? state.photos
        : sortPhotos(state.photos, state.sortConfig, state.imageMetadata),
    // metadataVersion is the invalidation signal for image-metadata sorts
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      state.photos,
      state.sortConfig,
      state.metadataVersion,
      state.imageMetadata,
      sortingDisabled,
    ],
  );

  const [listSearchQuery, setListSearchQuery] = useState("");
  const [selectionCount, setSelectionCount] = useState(0);

  useEffect(() => {
    setListSearchQuery("");
  }, [state.folder]);

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

  // Off-thread search via Web Worker.  The hook subscribes to the metadata
  // and draft-edit stores directly, so any mutation (streamed ExifTool
  // results, draft edits) refreshes results without the App needing to
  // forward each change.  See `src/hooks/useSearchWorker.ts`.
  const { matched: searchMatched, pending: searchPending } = useSearchWorker({
    photos: sortedPhotos,
    imageMetadataStore: state.imageMetadata,
    draftEditsStore: state.draftEditsStore,
    targetDraftEditsStore: state.targetDraftEditsStore,
    query: listSearchQuery,
    createWorker: createSearchWorker,
  });

  const displayPhotos = useMemo(() => {
    if (searchMatched === null) return sortedPhotos;
    return sortedPhotos.filter((p) => searchMatched.has(p.relative_path));
  }, [sortedPhotos, searchMatched]);

  useEffect(() => {
    const len = displayPhotos.length;
    if (state.selectedIndex !== null && state.selectedIndex >= len) {
      actions.selectPhoto(null);
    }
    if (
      state.galleryIndex !== null &&
      (len === 0 || state.galleryIndex >= len)
    ) {
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
      actions.navigateGallery(delta, { listLength: displayPhotos.length });
    },
    [actions, displayPhotos.length],
  );

  const listSearchActive = listSearchQueryIsActive(listSearchQuery);
  const emptySearchMessage =
    listSearchActive && sortedPhotos.length > 0 && displayPhotos.length === 0
      ? "No photos match your search."
      : null;

  const draftCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const [path, edits] of Object.entries(state.draftEdits)) {
      counts[path] = Object.keys(edits).length;
    }
    for (const [path, edits] of Object.entries(state.targetDraftEdits)) {
      counts[path] = (counts[path] ?? 0) + Object.keys(edits).length;
    }
    return counts;
  }, [state.draftEdits, state.targetDraftEdits]);

  const targetVerifyOutcomeCount = Object.values(
    state.targetVerifyOutcomes,
  ).reduce((count, entries) => count + Object.keys(entries).length, 0);
  const verificationDialog = state.applying
    ? null
    : verificationDialogToShow(
        targetVerifyOutcomeCount,
        Object.keys(state.verifyOutcomes).length,
      );

  const draftEditsSummary = useMemo(() => {
    const entries = Object.values(draftCounts).filter((count) => count > 0);
    return entries.length > 0
      ? { files: entries.length, edits: entries.reduce((a, b) => a + b, 0) }
      : null;
  }, [draftCounts]);

  const columnDialogAllKeys = useMemo(() => {
    if (!showColumnDialog) return [];
    return computeEffectiveMetadataKeyFrequency(
      state.photos,
      state.imageMetadata,
      state.draftEdits,
    );
  }, [
    showColumnDialog,
    state.photos,
    state.imageMetadata,
    state.draftEdits,
    state.metadataVersion,
    metadataRemaining,
  ]);

  const onClickDraftSummary = useCallback(() => {
    setListSearchQuery("has:edits");
  }, []);

  /**
   * Resolve the GPS payload for a set of rel-paths into the shape
   * the geocode_images_cmd expects. The frontend owns the
   * "drafts win over metadata" precedence so the backend never has
   * to read the typed-draft store. See docs/REVERSE_GEOCODE_PLAN.md
   * §2. Items with no GPS are still included with `lat`/`lon` null —
   * the backend surfaces them as `no_gps` failures so the user sees
   * the breakdown in the done panel rather than silently dropping
   * them at the call site.
   */
  const buildGeocodeItems = useCallback(
    (relPaths: string[]): GeocodeRequestItem[] => {
      return relPaths.map((relPath) => {
        const meta = state.imageMetadata.get(relPath);
        const metaBag = meta === "loading" ? undefined : meta;
        return buildGeocodeRequestItemForFile(relPath, {
          metadata: metaBag,
          occurrences: state.imageMetadataOccurrences.get(relPath),
          legacyDrafts: state.draftEdits[relPath],
          targetDrafts: state.targetDraftEdits[relPath],
        });
      });
    },
    [
      state.imageMetadata,
      state.imageMetadataOccurrences,
      state.draftEdits,
      state.targetDraftEdits,
    ],
  );

  return (
    <>
      <ErrorBanner
        errors={state.workerErrors}
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
        draftEdits={state.draftEdits}
        draftCounts={draftCounts}
        onDiscardAllEdits={(paths) => actions.discardAllDraftEdits(paths)}
        onApplyEdits={(paths) => actions.applyDraftEdits(paths)}
        onGenerateAiDescription={(relPaths) => {
          setDescribeOverwrite(
            countDescribeOverwrites(
              relPaths,
              state.imageMetadata,
              state.draftEdits,
            ),
          );
          describe.actions.start(state.folder, relPaths);
        }}
        onGeocode={(relPaths) => {
          setGeocodeOverwrite(
            countGeocodeOverwrites(
              relPaths,
              state.imageMetadata,
              state.draftEdits,
            ),
          );
          geocode.actions.start(state.folder, buildGeocodeItems(relPaths));
        }}
        onNormalise={(relPaths) => {
          // Default enabled groups: every v1 group. User can untick
          // individual groups in the confirm dialog.
          const initialGroups = ALL_NORMALISE_GROUPS;
          const items = buildNormaliseItems(
            relPaths,
            metadataStoreLookup(state.imageMetadata),
            state.draftEdits,
            initialGroups,
          );
          normalise.actions.start(state.folder, items, [...initialGroups]);
        }}
        onCopyPaths={onCopyPaths}
        onSelectionCountChange={setSelectionCount}
        onRemoveFieldFromSelectedPhotos={(id, relPaths) => {
          // Temporary bridge boundary: bulk remove-field remains schema-v4.
          for (const relPath of relPaths) {
            const existing =
              state.draftEdits[relPath]?.[schemaDefinitionIdToken(id)]?.edit;
            if (existing?.intent === "Delete" && existing?.value === null) {
              continue;
            }
            actions.setMetadataDraftBatch(relPath, [
              { id, edit: { value: null, intent: "Delete" } },
            ]);
          }
        }}
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
          imageMetadataOccurrences={state.imageMetadataOccurrences}
          typedDraftEdits={
            state.draftEdits[displayPhotos[state.galleryIndex].relative_path]
          }
          targetDraftEdits={
            state.targetDraftEdits[
              displayPhotos[state.galleryIndex].relative_path
            ]
          }
          targetDraftPersistence={state.targetDraftPersistence}
          onSetExistingOccurrenceDraft={actions.setExistingOccurrenceDraft}
          onSetMetadataDraftBatch={actions.setMetadataDraftBatch}
          onSetGpsTargetDraftBatch={actions.setGpsTargetDraftBatch}
          onSetNewPropertyDraft={actions.setNewPropertyDraft}
          onDiscardTargetPropertyDraft={actions.discardTargetPropertyDraft}
          onDiscardDraft={actions.discardDraftValue}
          onDiscardDraftBatch={actions.discardDraftValues}
          onDiscardAllEdits={actions.discardAllDraftEdits}
          onApplyEdits={(path) => actions.applyDraftEdits(path)}
          onGenerateAiDescription={(relPath) => {
            setDescribeOverwrite(
              countDescribeOverwrites(
                [relPath],
                state.imageMetadata,
                state.draftEdits,
              ),
            );
            describe.actions.start(state.folder, [relPath]);
          }}
          onGeocode={(relPath) => {
            setGeocodeOverwrite(
              countGeocodeOverwrites(
                [relPath],
                state.imageMetadata,
                state.draftEdits,
              ),
            );
            geocode.actions.start(state.folder, buildGeocodeItems([relPath]));
          }}
          onNormalise={(relPath) => {
            const initialGroups = ALL_NORMALISE_GROUPS;
            const items = buildNormaliseItems(
              [relPath],
              metadataStoreLookup(state.imageMetadata),
              state.draftEdits,
              initialGroups,
            );
            normalise.actions.start(state.folder, items, [...initialGroups]);
          }}
          onShowInFileExplorer={(relPath) => {
            const idx = displayPhotos.findIndex(
              (p) => p.relative_path === relPath,
            );
            if (idx >= 0) void onShowInExplorer(idx);
          }}
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
      {state.applying && (
        <ApplyProgressDialog
          applying={state.applying}
          onCancel={actions.cancelApplyEdits}
        />
      )}
      {verificationDialog === "target" && (
        <TargetVerifyOutcomeDialog
          outcomes={state.targetVerifyOutcomes}
          onAccept={actions.acceptTargetVerifyOutcome}
          onKeep={actions.keepTargetDraftAndDismissOutcome}
          onDiscard={actions.discardTargetDraftAndOutcome}
          onDismissAll={actions.dismissAllTargetVerifyOutcomes}
        />
      )}
      {verificationDialog === "legacy" && (
        <VerifyOutcomeDialog
          outcomes={state.verifyOutcomes}
          onAccept={actions.acceptVerifyOutcome}
          onRevert={actions.revertVerifyOutcome}
          onDismiss={actions.dismissVerifyOutcome}
          onDismissAll={actions.dismissAllVerifyOutcomes}
        />
      )}
      <StatusBar
        photoCount={displayPhotos.length}
        photoCountTotal={listSearchActive ? sortedPhotos.length : undefined}
        scanning={state.scanning}
        metadataProgress={state.metadataProgress}
        selectedCount={selectionCount}
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
  // Temporary bridge boundary: AI description, geocode and normalise remain
  // explicit schema-v4 producers. Each must migrate deliberately later.
  const mergeBatchEdits = useCallback(
    (relPath: string, edits: MetadataDraftEntry[]) => {
      if (edits.length > 0) actions.setMetadataDraftBatch(relPath, edits);
    },
    [actions],
  );
  const describe = useDescribeImages({ onApplyEdits: mergeBatchEdits });
  const geocode = useGeocodeImages({ onApplyEdits: mergeBatchEdits });
  const normalise = useNormaliseMetadata({ onApplyEdits: mergeBatchEdits });

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
                Building tag schema from ExifTool. This only happens once.
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
          <StatusBar
            photoCount={0}
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
          onConfirm={describe.actions.confirm}
          onCancel={describe.actions.cancel}
          onClose={describe.actions.close}
        />
      )}

      {geocode.open && (
        <GeocodeProgressDialog
          state={geocode.state}
          overwriteInfo={geocodeOverwrite}
          onConfirm={geocode.actions.confirm}
          onCancel={geocode.actions.cancel}
          onClose={geocode.actions.close}
        />
      )}

      {normalise.open && (
        <NormaliseProgressDialog
          state={normalise.state}
          onConfirm={normalise.actions.confirm}
          onCancel={normalise.actions.cancel}
          onClose={normalise.actions.close}
          onSetEnabledGroups={normalise.actions.setEnabledGroups}
        />
      )}
    </div>
  );
}

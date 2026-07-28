/**
 * Right-click menu for a file-list row.
 *
 * The set of options depends on the current multi-selection: View /
 * Show in Explorer always act on the right-clicked row's index, but
 * Copy Paths / batch flows (Geocode, AI Description, Normalise) act on
 * the union of selected rows. Apply/Discard further filter to rows
 * that actually carry drafts.
 */
import type { FileInfo, FileMetadataOccurrencesStore } from "../types";
import type { TargetDraftEditsByFile } from "../targetDraftEdits";
import { ContextMenu } from "./ContextMenu";
import {
  confirmApplyEdits,
  confirmDiscardEdits,
} from "../utils/applyDiscardPrompts";

interface Props {
  x: number;
  y: number;
  contextMenuIndex: number;
  selectedIndices: Set<number>;
  files: FileInfo[];
  fileMetadataOccurrences?: FileMetadataOccurrencesStore;
  targetDraftEdits: TargetDraftEditsByFile;
  onFileOpen: (index: number) => void;
  onShowInExplorer: (index: number) => void;
  onCopyPaths?: (relativePaths: string[]) => void;
  onBulkEdit?: (relativePaths: string[]) => void;
  onShowOnMap?: (relativePaths: string[]) => void;
  onGenerateAiDescription?: (relativePaths: string[]) => void;
  onGeocode?: (relativePaths: string[]) => void;
  onNormalise?: (relativePaths: string[]) => void;
  onApplyEdits?: (relativePaths: string[]) => void;
  onDiscardAllEdits?: (relativePaths: string[]) => void;
  onClose: () => void;
}

export function FileListContextMenu({
  x,
  y,
  contextMenuIndex,
  selectedIndices,
  files,
  fileMetadataOccurrences,
  targetDraftEdits,
  onFileOpen,
  onShowInExplorer,
  onCopyPaths,
  onBulkEdit,
  onShowOnMap,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onApplyEdits,
  onDiscardAllEdits,
  onClose,
}: Props) {
  const indices = Array.from(selectedIndices).sort((a, b) => a - b);
  const effectiveIndices = indices.length > 0 ? indices : [contextMenuIndex];
  const selectedFiles = effectiveIndices
    .map((i) => files[i])
    .filter((file): file is FileInfo => file !== undefined);
  const selectedPaths = selectedFiles.map((file) => file.relative_path);
  const failedMetadataPath = selectedPaths.find(
    (path) => fileMetadataOccurrences?.get(path) === "failed",
  );
  const hasMetadataFailure = failedMetadataPath !== undefined;
  const metadataFailureTitle = hasMetadataFailure
    ? `Metadata could not be loaded for '${failedMetadataPath}'. This action is unavailable while the selection contains a metadata error.`
    : undefined;
  const selectedImageCount = selectedFiles.filter(
    (file) => file.media_kind === "image",
  ).length;
  const allSelectedFilesAreImages =
    selectedFiles.length > 0 && selectedImageCount === selectedFiles.length;
  const mixedMediaSelection =
    selectedImageCount > 0 && selectedImageCount < selectedFiles.length;
  const editablePaths = selectedPaths.filter(
    (path) => Object.keys(targetDraftEdits[path] ?? {}).length > 0,
  );
  const totalEdits = editablePaths.reduce(
    (sum, path) => sum + Object.keys(targetDraftEdits[path] ?? {}).length,
    0,
  );
  const count = selectedPaths.length;
  const noun = count === 1 ? "file" : "files";
  const firstIndex = effectiveIndices[0];
  return (
    <ContextMenu
      x={x}
      y={y}
      options={[
        {
          label:
            count > 1
              ? `View (${files[firstIndex]?.filename ?? "first"})`
              : "View",
          onClick: () => onFileOpen(firstIndex),
        },
        {
          label:
            count > 1
              ? `Show in File Explorer (${files[firstIndex]?.filename ?? "first"})`
              : "Show in File Explorer",
          onClick: () => onShowInExplorer(firstIndex),
        },
        ...(onCopyPaths && selectedPaths.length > 0
          ? [
              {
                label: count > 1 ? `Copy Paths (${count})` : "Copy Path",
                onClick: () => onCopyPaths(selectedPaths),
              },
            ]
          : []),
        ...(onBulkEdit && selectedPaths.length > 0
          ? [
              {
                label: `Bulk Edit (${count} ${noun})...`,
                disabled: hasMetadataFailure,
                title: metadataFailureTitle,
                onClick: () => {
                  onClose();
                  onBulkEdit(selectedPaths);
                },
              },
            ]
          : []),
        ...(onShowOnMap && selectedPaths.length > 0
          ? [
              {
                label:
                  count > 1 ? `Show on Map (${count} ${noun})` : "Show on Map",
                disabled: hasMetadataFailure,
                title: metadataFailureTitle,
                onClick: () => {
                  onClose();
                  onShowOnMap(selectedPaths);
                },
              },
            ]
          : []),
        ...(onGenerateAiDescription &&
        selectedPaths.length > 0 &&
        (allSelectedFilesAreImages || mixedMediaSelection)
          ? [
              {
                label:
                  count > 1
                    ? `Generate AI Description… (${count} ${noun})`
                    : "Generate AI Description…",
                disabled: !allSelectedFilesAreImages || hasMetadataFailure,
                title: mixedMediaSelection
                  ? "AI Describe requires an image-only selection"
                  : metadataFailureTitle,
                onClick: () => {
                  onClose();
                  onGenerateAiDescription(selectedPaths);
                },
              },
            ]
          : []),
        // surfaces no_gps as a per-image failure in the done panel
        // instead of hiding the entry (which would be more confusing
        // than the silent skip behaviour).
        ...(onGeocode && selectedPaths.length > 0
          ? [
              {
                label:
                  count > 1
                    ? `Reverse Geocode… (${count} ${noun})`
                    : "Reverse Geocode…",
                disabled: hasMetadataFailure,
                title: metadataFailureTitle,
                onClick: () => {
                  onClose();
                  onGeocode(selectedPaths);
                },
              },
            ]
          : []),
        // Metadata-normalisation entry — always visible when ≥1 file
        // selected. Per-group toggles live inside the dialog. See
        // docs/NORMALISE_METADATA_PLAN.md §13.
        ...(onNormalise && selectedPaths.length > 0
          ? [
              {
                label:
                  count > 1
                    ? `Normalise Metadata… (${count} ${noun})`
                    : "Normalise Metadata…",
                disabled: hasMetadataFailure,
                title: metadataFailureTitle,
                onClick: () => {
                  onClose();
                  onNormalise(selectedPaths);
                },
              },
            ]
          : []),
        ...(editablePaths.length > 0 && onApplyEdits
          ? [
              {
                label:
                  editablePaths.length > 1
                    ? `Apply edits… (${editablePaths.length} ${editablePaths.length === 1 ? "file" : "files"})`
                    : "Apply edits…",
                disabled: hasMetadataFailure,
                title: metadataFailureTitle,
                onClick: async () => {
                  const target =
                    editablePaths.length === 1
                      ? (files[
                          effectiveIndices.find(
                            (i) => files[i]?.relative_path === editablePaths[0],
                          )!
                        ]?.filename ?? editablePaths[0])
                      : `${editablePaths.length} files`;
                  const confirmed = await confirmApplyEdits({
                    editCount: totalEdits,
                    target,
                    fileCount: editablePaths.length,
                  });
                  if (confirmed) {
                    onClose();
                    onApplyEdits(editablePaths);
                  }
                },
              },
            ]
          : []),
        ...(editablePaths.length > 0 && onDiscardAllEdits
          ? [
              {
                label:
                  editablePaths.length > 1
                    ? `Discard all edits… (${editablePaths.length} ${editablePaths.length === 1 ? "file" : "files"})`
                    : "Discard all edits…",
                onClick: async () => {
                  const confirmed = await confirmDiscardEdits({
                    editCount: totalEdits,
                    scope: `${editablePaths.length} ${editablePaths.length === 1 ? "file" : "files"}`,
                    preposition: "across",
                  });
                  if (confirmed) onDiscardAllEdits(editablePaths);
                },
              },
            ]
          : []),
      ]}
      onClose={onClose}
    />
  );
}

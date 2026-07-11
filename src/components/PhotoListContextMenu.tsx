/**
 * Right-click menu for a photo-list row.
 *
 * The set of options depends on the current multi-selection: View /
 * Show in Explorer always act on the right-clicked row's index, but
 * Copy Paths / batch flows (Geocode, AI Description, Normalise) act on
 * the union of selected rows. Apply/Discard further filter to rows
 * that actually carry drafts.
 */
import type { MetadataDraftEditsByFile, PhotoInfo } from "../types";
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
  photos: PhotoInfo[];
  draftEdits: MetadataDraftEditsByFile;
  onPhotoOpen: (index: number) => void;
  onShowInExplorer: (index: number) => void;
  onCopyPaths?: (relativePaths: string[]) => void;
  onGenerateAiDescription?: (relativePaths: string[]) => void;
  onGeocode?: (relativePaths: string[]) => void;
  onNormalise?: (relativePaths: string[]) => void;
  onApplyEdits?: (relativePaths: string[]) => void;
  onDiscardAllEdits?: (relativePaths: string[]) => void;
  onClose: () => void;
}

export function PhotoListContextMenu({
  x,
  y,
  contextMenuIndex,
  selectedIndices,
  photos,
  draftEdits,
  onPhotoOpen,
  onShowInExplorer,
  onCopyPaths,
  onGenerateAiDescription,
  onGeocode,
  onNormalise,
  onApplyEdits,
  onDiscardAllEdits,
  onClose,
}: Props) {
  const indices = Array.from(selectedIndices).sort((a, b) => a - b);
  const effectiveIndices = indices.length > 0 ? indices : [contextMenuIndex];
  const selectedPaths = effectiveIndices
    .map((i) => photos[i]?.relative_path)
    .filter((p): p is string => typeof p === "string");
  const editablePaths = selectedPaths.filter(
    (p) => draftEdits[p] && Object.keys(draftEdits[p]).length > 0,
  );
  const totalEdits = editablePaths.reduce(
    (sum, p) => sum + Object.keys(draftEdits[p] ?? {}).length,
    0,
  );
  const count = selectedPaths.length;
  const noun = count === 1 ? "photo" : "photos";
  const firstIndex = effectiveIndices[0];

  return (
    <ContextMenu
      x={x}
      y={y}
      options={[
        {
          label:
            count > 1
              ? `View (${photos[firstIndex]?.filename ?? "first"})`
              : "View",
          onClick: () => onPhotoOpen(firstIndex),
        },
        {
          label:
            count > 1
              ? `Show in File Explorer (${photos[firstIndex]?.filename ?? "first"})`
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
        ...(onGenerateAiDescription && selectedPaths.length > 0
          ? [
              {
                label:
                  count > 1
                    ? `Generate AI Description… (${count} ${noun})`
                    : "Generate AI Description…",
                onClick: () => {
                  onClose();
                  onGenerateAiDescription(selectedPaths);
                },
              },
            ]
          : []),
        // Reverse-geocode entry. Always visible regardless of GPS
        // presence — per docs/REVERSE_GEOCODE_PLAN.md §5, the backend
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
                onClick: () => {
                  onClose();
                  onGeocode(selectedPaths);
                },
              },
            ]
          : []),
        // Metadata-normalisation entry — always visible when ≥1 photo
        // selected. Per-group toggles live inside the dialog. See
        // docs/NORMALISE_METADATA_PLAN.md §13.
        ...(onNormalise && selectedPaths.length > 0
          ? [
              {
                label:
                  count > 1
                    ? `Normalise Metadata… (${count} ${noun})`
                    : "Normalise Metadata…",
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
                    ? `Apply edits… (${editablePaths.length} ${editablePaths.length === 1 ? "photo" : "photos"})`
                    : "Apply edits…",
                onClick: async () => {
                  const target =
                    editablePaths.length === 1
                      ? (photos[
                          effectiveIndices.find(
                            (i) =>
                              photos[i]?.relative_path === editablePaths[0],
                          )!
                        ]?.filename ?? editablePaths[0])
                      : `${editablePaths.length} photos`;
                  const confirmed = await confirmApplyEdits({
                    editCount: totalEdits,
                    target,
                    photoCount: editablePaths.length,
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
                    ? `Discard all edits… (${editablePaths.length} ${editablePaths.length === 1 ? "photo" : "photos"})`
                    : "Discard all edits…",
                onClick: async () => {
                  const confirmed = await confirmDiscardEdits({
                    editCount: totalEdits,
                    scope: `${editablePaths.length} ${editablePaths.length === 1 ? "photo" : "photos"}`,
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

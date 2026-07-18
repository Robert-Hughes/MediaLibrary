import { useEffect } from "react";
import type { OccurrenceDetailsRow } from "../../details/occurrenceDetailsPresentation";
import { ContextMenu } from "../ContextMenu";

export function OccurrenceMetadataRowContextMenu({
  x,
  y,
  row,
  onEdit,
  onEditDestination,
  onEditGps,
  onDiscard,
  onRemove,
  onClose,
  gpsEditingUnavailableReason,
}: {
  x: number;
  y: number;
  row: OccurrenceDetailsRow;
  onEdit?: () => void;
  onEditDestination?: () => void;
  onEditGps?: () => void;
  onDiscard?: () => void;
  onRemove?: () => void;
  onClose: () => void;
  gpsEditingUnavailableReason?: string;
}) {
  const options = (() => {
    switch (row.kind) {
      case "ExistingOccurrenceRow": {
        const staleOrDuplicate =
          row.staleDraft !== null || row.duplicateOccurrenceId;
        const targetable = row.targetability.kind === "targetable";
        return [
          ...(!staleOrDuplicate && targetable && onEdit
            ? [{ label: "Edit…", onClick: onEdit }]
            : []),
          ...(!staleOrDuplicate && onEditGps
            ? [
                {
                  label: "Edit GPS…",
                  onClick: onEditGps,
                  disabled: gpsEditingUnavailableReason !== undefined,
                  title: gpsEditingUnavailableReason,
                },
              ]
            : []),
          ...(row.draftTargets.length > 0 && onDiscard
            ? [{ label: "Discard edit", onClick: onDiscard }]
            : []),
          ...(!staleOrDuplicate && targetable && onRemove
            ? [{ label: "Remove", onClick: onRemove }]
            : []),
        ];
      }
      case "NewPropertyRow":
        return [
          ...(onEdit ? [{ label: "Edit value…", onClick: onEdit }] : []),
          ...(onEditDestination
            ? [{ label: "Edit destination…", onClick: onEditDestination }]
            : []),
          ...(onDiscard ? [{ label: "Discard edit", onClick: onDiscard }] : []),
        ];
      case "MissingOccurrenceDraftRow":
        return onDiscard ? [{ label: "Discard edit", onClick: onDiscard }] : [];
    }
  })();

  const empty = options.length === 0;
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);
  if (empty) return null;

  return <ContextMenu x={x} y={y} options={options} onClose={onClose} />;
}

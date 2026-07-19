import type { MouseEvent } from "react";
import type { OccurrenceDetailsRow } from "../../details/occurrenceDetailsPresentation";
import { datatypesMatch } from "../../utils/datatype";
import {
  buildOccurrenceNameTooltip,
  buildOccurrenceValueTooltip,
  rowDatatypeInfo,
} from "../../details/occurrenceDetailsTooltips";
import { DatatypeBadge } from "../DatatypeBadge";
import { HighlightedText } from "../HighlightedText";
import { schemaDefinitionIdToken } from "../../utils/schemaDefinitionId";
import { metadataOccurrenceIdToken } from "../../utils/metadataOccurrenceId";
import { metadataDraftTargetToken } from "../../utils/metadataDraftTarget";

export function OccurrenceMetadataRow({
  row,
  searchQuery,
  onContextMenu,
  forceReadOnly = false,
  forceReadOnlyReason,
}: {
  row: OccurrenceDetailsRow;
  searchQuery: string;
  onContextMenu?: (event: MouseEvent<HTMLTableRowElement>) => void;
  forceReadOnly?: boolean;
  forceReadOnlyReason?: string;
}) {
  const datatypeInfo = rowDatatypeInfo(row);
  const { schemaInfo, valueInfo, draftInfo } = datatypeInfo;
  const showValueBadge =
    valueInfo != null &&
    (schemaInfo == null || !datatypesMatch(valueInfo.code, schemaInfo.code));
  const showDraftBadge =
    draftInfo != null &&
    ((valueInfo != null && draftInfo.code !== valueInfo.code) ||
      (schemaInfo != null &&
        !datatypesMatch(draftInfo.code, schemaInfo.code)) ||
      (schemaInfo == null && valueInfo == null));
  const readOnly =
    forceReadOnly ||
    row.kind === "MissingOccurrenceDraftRow" ||
    (row.kind === "ExistingOccurrenceRow" &&
      (row.targetability.kind === "read-only" ||
        row.duplicateOccurrenceId ||
        row.staleDraft !== null));
  const hasPendingOperation = row.draftTargets.length > 0;
  const hasDisplayedDraft =
    row.kind === "ExistingOccurrenceRow"
      ? row.draft !== null
      : hasPendingOperation;
  const previewUnsupported =
    row.kind === "ExistingOccurrenceRow" && row.effectiveDraftApplied === false;
  const schemaId =
    row.kind === "ExistingOccurrenceRow"
      ? row.occurrence.schema_id
      : row.target.schema_id;
  const nameTooltip = buildOccurrenceNameTooltip({
    row,
    datatypeInfo,
    editable: !readOnly,
    forceReadOnlyReason,
  });
  const valueTooltip = buildOccurrenceValueTooltip({ row, datatypeInfo });

  return (
    <tr
      className={readOnly ? "details-row details-row--readonly" : "details-row"}
      data-testid="details-row"
      data-row-kind={row.kind}
      data-row-key={row.key}
      data-schema-id={schemaDefinitionIdToken(schemaId)}
      data-occurrence-token={
        row.kind === "ExistingOccurrenceRow"
          ? metadataOccurrenceIdToken(row.occurrence.id)
          : undefined
      }
      data-target-token={
        row.kind === "NewPropertyRow" ||
        row.kind === "MissingOccurrenceDraftRow"
          ? metadataDraftTargetToken(row.target)
          : row.targetability.kind === "targetable"
            ? metadataDraftTargetToken(row.targetability.target)
            : undefined
      }
      data-readonly={readOnly ? "true" : undefined}
      data-has-exact-draft={hasDisplayedDraft ? "true" : undefined}
      data-has-pending-operation={hasPendingOperation ? "true" : undefined}
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event);
      }}
    >
      <td
        className="details-key"
        title={nameTooltip}
        style={
          hasPendingOperation ? { color: "var(--accent-draft)" } : undefined
        }
      >
        <span
          data-testid="details-metadata-row"
          data-row-kind={row.kind}
          data-row-key={row.key}
        />
        {schemaInfo ? (
          <DatatypeBadge
            code={schemaInfo.code}
            label={schemaInfo.label}
            variant="schema"
            showTitle={false}
          />
        ) : null}
        <HighlightedText text={row.label} searchQuery={searchQuery} />
        {row.originQualifier ? (
          <span className="details-occurrence-origin">
            [{row.originQualifier}]
          </span>
        ) : null}
        {row.status.label ? (
          <span
            className="details-occurrence-resolution"
            data-testid="details-row-status"
          >
            {row.status.label}
          </span>
        ) : null}
      </td>
      <td
        className={
          readOnly ? "details-value details-value--readonly" : "details-value"
        }
        data-readonly={readOnly ? "true" : undefined}
        title={valueTooltip}
      >
        {previewUnsupported ? (
          <>
            {showValueBadge && valueInfo ? (
              <DatatypeBadge
                code={valueInfo.code}
                label={valueInfo.label}
                variant="value"
                showTitle={false}
              />
            ) : null}
            <HighlightedText
              text={row.currentValue}
              searchQuery={searchQuery}
            />{" "}
            <strong className="draft-new draft-new--unavailable">
              Preview unavailable
            </strong>
          </>
        ) : row.stagedValue !== null ? (
          <>
            {row.currentValue ? (
              <>
                {showValueBadge && valueInfo ? (
                  <DatatypeBadge
                    code={valueInfo.code}
                    label={valueInfo.label}
                    variant="value"
                    showTitle={false}
                  />
                ) : null}
                <s className="draft-original" style={{ opacity: 0.6 }}>
                  <HighlightedText
                    text={row.currentValue}
                    searchQuery={searchQuery}
                  />
                </s>{" "}
              </>
            ) : null}
            {showDraftBadge && draftInfo ? (
              <DatatypeBadge
                code={draftInfo.code}
                label={draftInfo.label}
                variant="draft"
                showTitle={false}
              />
            ) : null}
            <strong className="draft-new">
              <HighlightedText
                text={row.stagedValue}
                searchQuery={searchQuery}
              />
            </strong>
          </>
        ) : hasDisplayedDraft ? (
          <>
            {row.currentValue ? (
              <s className="draft-original" style={{ opacity: 0.6 }}>
                <HighlightedText
                  text={row.currentValue}
                  searchQuery={searchQuery}
                />
              </s>
            ) : null}{" "}
            <strong className="draft-new">—</strong>
          </>
        ) : (
          <>
            {showValueBadge && valueInfo ? (
              <DatatypeBadge
                code={valueInfo.code}
                label={valueInfo.label}
                variant="value"
                showTitle={false}
              />
            ) : null}
            <HighlightedText
              text={row.currentValue}
              searchQuery={searchQuery}
            />
          </>
        )}
      </td>
    </tr>
  );
}

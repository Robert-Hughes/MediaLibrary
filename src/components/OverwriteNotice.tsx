/**
 * Inline notice rendered in the awaiting-confirm panel of every batch
 * dialog (Describe, Geocode, Normalise) when the selection includes
 * photos whose data the run would overwrite. Replaces the per-flow
 * pre-dialog `ask()` warnings — the cost/preview info and the overwrite
 * notice now live in one place.
 */
import { buildOverwriteWarning, type OverwriteWarningInput } from "./overwriteWarning";

interface Props {
  input: OverwriteWarningInput;
  testidPrefix: string;
}

export function OverwriteNotice({ input, testidPrefix }: Props) {
  const w = buildOverwriteWarning(input);
  if (!w) return null;
  return (
    <div
      data-testid={`${testidPrefix}-overwrite-notice`}
      style={{
        marginTop: 12,
        padding: "8px 10px",
        fontSize: 12,
        color: "var(--accent-error, #d33)",
        border: "1px solid var(--accent-error, #d33)",
        borderRadius: 4,
        background: "var(--accent-error-subtle, rgba(221,51,51,0.06))",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{w.title}</div>
      <div>{w.body}</div>
    </div>
  );
}

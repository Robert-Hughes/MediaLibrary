// ── Draft-edit helpers (Phase 3b) ─────────────────────────────────────────────
//
// The frontend draft layer carries typed `DraftEdit` values internally — see
// `METADATA_FORMATS_PLAN.md` §3 and `METADATA_FORMATS_DESIGN.md` §7.  These
// helpers bridge:
//
// - The legacy `Record<string, Record<string, string | null>>` Tauri-boundary
//   shape (load_draft_edits / save_draft_edits / apply_draft_edits_cmd still
//   send and receive this; the typed-payload Tauri commands are Phase 4 work).
// - The legacy `string | null` shape that components and tests still pass
//   around (will migrate to typed editors in Phase 4).
//
// Storage uses the typed shape so when typed editors arrive they have
// somewhere to write.  Display derives the legacy shape on the fly.

import type { DraftEdit, EditIntent, Variant } from "./types";

export type TypedDraftEditsByFile = Record<string, Record<string, DraftEdit>>;
export type LegacyDraftEditsByFile = Record<string, Record<string, string | null>>;

/**
 * Render the display string for a draft.
 *
 * Returns:
 * - `undefined` if no draft exists for the key
 * - `null`      if the draft is a Delete intent (UI shows "—" / strikethrough)
 * - otherwise   a string formed from the Variant value (matching the legacy
 *               `string | null` shape that components use today)
 */
export function displayStringOf(d: DraftEdit | undefined): string | null | undefined {
  if (d === undefined) return undefined;
  if (d.intent === "Delete") return null;
  return variantToDisplayString(d.value);
}

/** Wrap a legacy `string | null` edit into the typed shape. */
export function draftFromLegacyString(v: string | null): DraftEdit {
  if (v === null) {
    return { value: null, intent: "Delete" as EditIntent };
  }
  return { value: v, intent: "Set" as EditIntent };
}

/** Stringify a Variant for the legacy `string | null` display path. */
export function variantToDisplayString(v: Variant | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map(variantToDisplayString).join(", ");
  if (typeof v === "object") {
    return Object.entries(v)
      .map(([k, vv]) => `${k}: ${variantToDisplayString(vv as Variant)}`)
      .join("; ");
  }
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  return String(v);
}

/**
 * Convert the typed map into the legacy wire shape used by Tauri commands
 * (`save_draft_edits`, `apply_draft_edits_cmd`) and by existing components
 * that still read `Record<string, Record<string, string | null>>`.
 *
 * Drafts with no real change (undefined intent) are dropped.
 */
export function mapTypedToLegacy(typed: TypedDraftEditsByFile): LegacyDraftEditsByFile {
  const out: LegacyDraftEditsByFile = {};
  for (const [file, edits] of Object.entries(typed)) {
    const fileOut: Record<string, string | null> = {};
    for (const [key, d] of Object.entries(edits)) {
      if (d.intent === "Delete") {
        fileOut[key] = null;
      } else {
        fileOut[key] = variantToDisplayString(d.value);
      }
    }
    if (Object.keys(fileOut).length > 0) {
      out[file] = fileOut;
    }
  }
  return out;
}

/** Convert legacy load result (as returned by Tauri) into typed storage shape. */
export function mapLegacyToTyped(legacy: LegacyDraftEditsByFile): TypedDraftEditsByFile {
  const out: TypedDraftEditsByFile = {};
  for (const [file, edits] of Object.entries(legacy ?? {})) {
    const fileOut: Record<string, DraftEdit> = {};
    for (const [key, v] of Object.entries(edits)) {
      fileOut[key] = draftFromLegacyString(v);
    }
    out[file] = fileOut;
  }
  return out;
}

/**
 * Derive the legacy per-file map of `string | null` values for one file.
 * Used by App.tsx when threading drafts down into components that still
 * consume the legacy shape.
 */
export function deriveLegacyFileEdits(
  typedFile: Record<string, DraftEdit> | undefined,
): Record<string, string | null> {
  if (!typedFile) return {};
  const out: Record<string, string | null> = {};
  for (const [key, d] of Object.entries(typedFile)) {
    out[key] = d.intent === "Delete" ? null : variantToDisplayString(d.value);
  }
  return out;
}

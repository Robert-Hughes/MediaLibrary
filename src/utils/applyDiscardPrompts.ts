/**
 * Confirmation prompts for apply / discard draft-edit gestures.
 *
 * Both DetailsPane (single-photo header buttons) and the photo-list
 * row context-menu drive the same backend pathway, so the prompt
 * wording lives in one place. Tweaks to the wording (e.g. "no backup"
 * disclaimer) automatically apply to every entry point.
 */
import { ask } from "@tauri-apps/plugin-dialog";

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

export interface ApplyEditsConfirmArgs {
  /** Total number of pending edits about to be flushed. */
  editCount: number;
  /**
   * Human-readable description of the affected target — typically a
   * filename for a single photo or "N photos" for a batch. The text
   * appears verbatim in the prompt.
   */
  target: string;
  /** Number of distinct photos affected; drives plural-vs-singular for "file"/"files". */
  photoCount: number;
}

export async function confirmApplyEdits({
  editCount,
  target,
  photoCount,
}: ApplyEditsConfirmArgs): Promise<boolean> {
  const editNoun = plural(editCount, "edit", "edits");
  const fileNoun = plural(photoCount, "file", "files");
  return ask(
    `Apply ${editCount} ${editNoun} to ${target}?\n\nThis will permanently modify the original image ${fileNoun}. There is no backup.`,
    { title: "Apply Edits", kind: "warning" },
  );
}

export interface DiscardEditsConfirmArgs {
  /** Total number of edits about to be discarded. */
  editCount: number;
  /**
   * Scope description; either "this photo" (single-photo header) or
   * "N photos" (batch from the row context-menu).
   */
  scope: string;
  /**
   * Preposition between the count and the scope. "for" reads
   * naturally for a single photo ("for this photo"); "across" reads
   * naturally for a batch ("across 3 photos"). Defaults to "for".
   */
  preposition?: "for" | "across";
}

export async function confirmDiscardEdits({
  editCount,
  scope,
  preposition = "for",
}: DiscardEditsConfirmArgs): Promise<boolean> {
  const editNoun = plural(editCount, "edit", "edits");
  return ask(
    `Are you sure you want to discard ${editCount} ${editNoun} ${preposition} ${scope}?`,
    { title: "Discard Edits", kind: "warning" },
  );
}

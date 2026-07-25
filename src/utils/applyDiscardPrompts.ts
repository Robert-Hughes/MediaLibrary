/**
 * Confirmation prompts for apply / discard draft-edit gestures.
 *
 * Both DetailsPane (single-file header buttons) and the file-list
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
   * filename for a single file or "N files" for a batch. The text
   * appears verbatim in the prompt.
   */
  target: string;
  /** Number of distinct files affected; drives plural-vs-singular for "file"/"files". */
  fileCount: number;
}

export async function confirmApplyEdits({
  editCount,
  target,
  fileCount,
}: ApplyEditsConfirmArgs): Promise<boolean> {
  const editNoun = plural(editCount, "edit", "edits");
  const fileNoun = plural(fileCount, "file", "files");
  return ask(
    `Apply ${editCount} ${editNoun} to ${target}?\n\nThis will permanently modify the original image ${fileNoun}. There is no backup.`,
    { title: "Apply Edits", kind: "warning" },
  );
}

export interface DiscardEditsConfirmArgs {
  /** Total number of edits about to be discarded. */
  editCount: number;
  /**
   * Scope description; either "this file" (single-file header) or
   * "N files" (batch from the row context-menu).
   */
  scope: string;
  /**
   * Preposition between the count and the scope. "for" reads
   * naturally for a single file ("for this file"); "across" reads
   * naturally for a batch ("across 3 files"). Defaults to "for".
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

export async function confirmRemoveMetadataGroupFields({
  group,
  existingFieldsToDelete,
  stagedCreationsToCancel,
}: {
  group: string;
  existingFieldsToDelete: number;
  stagedCreationsToCancel: number;
}): Promise<boolean> {
  const affectedCount = existingFieldsToDelete + stagedCreationsToCancel;
  const fieldNoun = affectedCount === 1 ? "field" : "fields";
  const lines: string[] = [];
  if (existingFieldsToDelete > 0) {
    const existingNoun = existingFieldsToDelete === 1 ? "field" : "fields";
    const editNoun = existingFieldsToDelete === 1 ? "edit" : "edits";
    lines.push(
      `${existingFieldsToDelete} existing ${existingNoun} will receive pending delete ${editNoun}.`,
    );
  }
  if (stagedCreationsToCancel > 0) {
    const additionNoun =
      stagedCreationsToCancel === 1 ? "addition" : "additions";
    lines.push(
      `${stagedCreationsToCancel} staged new-property ${additionNoun} will be cancelled.`,
    );
  }
  return ask(
    `Stage removal of ${affectedCount} ${group} ${fieldNoun}?\n\n` +
      `${lines.join("\n")}\n\n` +
      `Nothing will be written to the image file until edits are applied.`,
    { title: `Remove ${group} Fields`, kind: "warning" },
  );
}

export async function confirmDiscardMetadataGroupEdits({
  group,
  editCount,
}: {
  group: string;
  editCount: number;
}): Promise<boolean> {
  const editNoun = editCount === 1 ? "edit" : "edits";
  return ask(
    `Discard ${editCount} pending ${group} field ${editNoun}?\n\n` +
      `This only removes pending edits for this file. It does not change the image file.`,
    { title: `Discard ${group} Edits`, kind: "warning" },
  );
}

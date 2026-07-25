/**
 * Shared text builder for the "already has X data, will overwrite with
 * drafts" notices that the batch dialogs (Describe, Geocode, Normalise)
 * show inside their awaiting-confirm panel.
 *
 * Previously the same copy was emitted via `ask()` before opening each
 * dialog. The pre-dialog warning has been folded into the dialog itself
 * so the cost estimate and the overwrite notice live side by side. The
 * builder now produces a body string without a trailing "Continue?" —
 * the Confirm button below the notice provides that affordance.
 */

export interface OverwriteWarningInput {
  /** How many selected files already have data the batch would overwrite. */
  existingCount: number;
  /** Total number of selected files. */
  totalCount: number;
  /** Heading displayed above the notice body. */
  title: string;
  /** Singular subject noun (e.g. "image"). */
  subjectSingular: string;
  /** Defaults to `subjectSingular + "s"`. */
  subjectPlural?: string;
  /**
   * Phrase that follows "already has": e.g. `"an AI description"` or
   * `"location data"`. Lower case, no trailing punctuation — the
   * builder adds the period.
   */
  dataPhrase: string;
  /**
   * Sentence describing what the action will do when exactly one file
   * is involved.
   */
  actionSingle: string;
  /**
   * Action sentence for the "all N selected ... already have" branch
   * (existingCount === totalCount and totalCount > 1). Falls back to
   * `actionSingle` if omitted.
   */
  actionPluralAll?: string;
  /**
   * Action sentence for the "X of N selected ... already have" branch
   * (existingCount < totalCount). Falls back to `actionPluralAll`, then
   * `actionSingle`.
   */
  actionPluralPartial?: string;
}

export interface OverwriteWarning {
  title: string;
  body: string;
}

/**
 * Build the title + body for an inline overwrite notice. Returns
 * `null` when `existingCount === 0`, signalling no notice is needed.
 */
export function buildOverwriteWarning(
  input: OverwriteWarningInput,
): OverwriteWarning | null {
  const {
    existingCount,
    totalCount,
    title,
    subjectSingular,
    subjectPlural = subjectSingular + "s",
    dataPhrase,
    actionSingle,
    actionPluralAll,
    actionPluralPartial,
  } = input;

  if (existingCount <= 0) return null;
  if (existingCount > totalCount || totalCount <= 0) return null;

  const pluralAll = actionPluralAll ?? actionSingle;
  const pluralPartial = actionPluralPartial ?? pluralAll;

  let prefix: string;
  let action: string;
  if (totalCount === 1) {
    prefix = `This ${subjectSingular} already has ${dataPhrase}.`;
    action = actionSingle;
  } else if (existingCount === totalCount) {
    prefix = `All ${totalCount} selected ${subjectPlural} already have ${dataPhrase}.`;
    action = pluralAll;
  } else {
    const verb = existingCount === 1 ? "has" : "have";
    prefix = `${existingCount} of ${totalCount} selected ${subjectPlural} already ${verb} ${dataPhrase}.`;
    action = pluralPartial;
  }

  return { title, body: `${prefix} ${action}` };
}

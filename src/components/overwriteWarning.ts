/**
 * Shared text builder for the "already has X data, will overwrite with
 * drafts — continue?" warnings that every batch flow shows before kicking
 * off a multi-select run.
 *
 * Describe and geocode both used to copy-paste the same three-branch
 * conditional (single / all-of-many / some-of-many) with slightly
 * different copy. The new metadata-normaliser feature wants the same
 * shape with again-different copy, so the pattern is extracted here as
 * a pure text builder rather than a React component — callers continue
 * to pass the resulting strings to `ask()` themselves.
 *
 * Plan reference: `docs/NORMALISE_METADATA_PLAN.md` §11 item 2.
 */

export interface OverwriteWarningInput {
  /** How many selected photos already have data the batch would overwrite. */
  existingCount: number;
  /** Total number of selected photos. */
  totalCount: number;
  /** Heading shown in the native confirm dialog. */
  title: string;
  /**
   * Singular noun used in the "This {subject}" branch. Existing call
   * sites use "image" (DetailsPane, single button) and "photo"
   * (PhotoList, multi-select context-menu). Kept as a parameter so the
   * extraction doesn't quietly change copy.
   */
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
   * Sentence describing what the action will do, used when exactly one
   * photo is involved. The builder appends "Continue?" after it.
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
   * `actionSingle`. Geocode uses this slot to insert
   * "...with drafts for those photos..." so the user knows partial
   * selection is honoured.
   */
  actionPluralPartial?: string;
}

export interface OverwriteWarning {
  title: string;
  body: string;
}

/**
 * Build the title + body for a batch overwrite confirmation. Returns
 * `null` when `existingCount === 0`, signalling no warning is needed.
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
    // Partial selection: conjugate by `existingCount` (1 → "has", >1 → "have").
    const verb = existingCount === 1 ? "has" : "have";
    prefix = `${existingCount} of ${totalCount} selected ${subjectPlural} already ${verb} ${dataPhrase}.`;
    action = pluralPartial;
  }

  return { title, body: `${prefix} ${action} Continue?` };
}

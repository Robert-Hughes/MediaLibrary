# Exact-ID and target-aware metadata manual validation

This checklist supplements automated schema, occurrence, draft-target, write,
verification and generated-workflow tests. Record the tested commit and execute
it against disposable copies only.

The current application has one active metadata-edit pipeline:
`MediaLibraryTargetDraftEdits.sqlite3` and
`MediaLibraryTargetApplyLog.jsonl`. A version-6
`MediaLibraryTargetDraftEdits.jsonl` is accepted only as a one-time migration
input. Historical `MediaLibraryDraftEdits.jsonl` and
`MediaLibraryApplyLog.jsonl` files are ignored and must remain untouched.

## Validation record

- Tested commit:
- Application version/build:
- ExifTool version:
- Operating system:
- Test folder:
- Tester:
- Date:

For each failure, record the checklist number, file format, friendly label,
exact `{table, tag_id, index?}`, complete occurrence and target diagnostics,
intended and observed semantic values, apply/readback outcome, and the relevant
application-log excerpt. Do not attach an original file when a redacted,
disposable reproduction is sufficient.

## Recommended disposable fixtures

Prepare a representative folder containing:

- JPEG files with EXIF, XMP, IPTC, GPS, list and LangAlt metadata;
- one file with IFD0 and IFD1 occurrences sharing a schema, such as
  `XResolution`;
- a Windows BMP and an OS/2 BMP;
- a file with no GPS metadata;
- several files suitable for batch Describe, Reverse Geocode and Normalise;
- copies that can be externally altered between staging and apply; and
- optional malformed and historical draft/apply files for persistence checks.

A prepared fixture pack is available at
`D:\Programming\Media\MediaLibrary\manual-fixtures`. Open its `working`
subfolder in MediaLibrary and read the pack's `README.md` before starting. Run
`scripts\reset-working.ps1` whenever a clean baseline is required.
Keep the application log open and use an independent ExifTool invocation for
readback comparisons.

## Core scan, schema and edit checks

- [ ] **1. Scan the folder.** Confirm every supported file appears and metadata
      loading completes without schema-gap errors for ordinary fields.

      _Recommended fixtures:_ open the entire `manual-fixtures\working` folder. Copy `optional\malformed_truncated.jpg` into it only for scan-isolation coverage.

- [ ] **2. Inspect common fields.** In Details, inspect EXIF, XMP, IPTC and GPS
      occurrences. Expected: every authoritative occurrence has its own row;
      values and datatypes match an independent ExifTool read; table/ID and
      occurrence diagnostics identify the exact field and definition.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg`.

- [ ] **3. Search.** Search by a friendly property name, description and value.
      Expected: matching files appear, while same-name definitions remain
      independently searchable by their displayed table context.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg`.

- [ ] **4. Add a property.** Use Add New Property and explicitly select one
      result. Expected: the chosen row shows table/ID context, the destination
      defaults to `TagInfo.group`, and the advanced line shows a complete selector
      such as `1IFD0:7ID-282:XResolution`.

- [ ] **5. Edit text and apply.** Change a writable scalar text field. Expected:
      the readback value matches and the draft clears only for the selected exact
      target.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg`; edit the writable scalar `XMP-photoshop:Headline`.

- [ ] **6. Edit a list.** Replace a writable text list, then exercise add and
      remove. Expected: items remain separate, with correct replacement/add/remove
      semantics after readback.

      _Recommended fixture:_ `05_lists_xmp_iptc.jpg`, which has separate XMP Subject and IPTC Keywords lists.

- [ ] **7. Edit GPS.** Change latitude, longitude and their reference fields
      together. Expected: the map position and each exact GPS field agree after
      readback.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg`, which has a complete N/E GPS set.

- [ ] **8. Edit LangAlt.** Where available, set `x-default` and another
      language, then remove the additional language. Expected: the complete map
      rereads beneath one writable exact LangAlt parent, and the removed language
      is absent from the file.

      _Recommended fixture:_ `06_langalt_description.jpg`, which has `x-default`, English and French alternatives.

- [ ] **9. Restart with drafts.** Leave unapplied drafts, close and reopen the
      same folder. Expected: version-5 target drafts reappear against the same exact
      occurrences or New Property destinations, and any custom family-1
      destination is restored.

- [ ] **10. Inspect a read-only collision.** Scan or open one Windows BMP and
      one OS/2 BMP. Inspect `File:BMPVersion` in Details. Expected: Windows resolves
      to `BMP::Main/0`, OS/2 resolves to `BMP::OS2/0`, both are read-only, and the
      identical friendly labels do not cause either definition to replace the
      other.

      _Recommended fixtures:_ `14_windows_v3.bmp` and `15_os2_v1.bmp`.

- [ ] **11. Inspect a writable collision.** In Add New Property, where the
      current ExifTool registry contains multiple writable definitions sharing a
      friendly label, confirm each result displays table, tag ID and optional index
      separately. If no suitable writable collision exists in this ExifTool
      version, record this check as not applicable.

- [ ] **12. Try unknown and read-only fields.** Expected: editor and apply
      actions are unavailable; missing schema information is never treated as
      writable.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg` for its read-only binary ThumbnailImage. Use `optional\malformed_truncated.jpg` or the harness for a genuinely unknown field.

- [ ] **13. Inspect apply/readback outcomes.** Apply a mixed set of edits.
      Expected: every success, mismatch or retained draft names the intended exact
      table, tag ID, optional index and complete target.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg`.

- [ ] **14. Inspect the identity layers.** For representative existing fields,
      use diagnostics or logs to record the friendly label, raw
      `RuntimeTagIdScope`, resolved `SchemaDefinitionId`, complete
      `MetadataOccurrenceId`, and `MetadataWriteTarget`. Expected: each appears in
      its own role; flattened LangAlt extraction members consolidate into one
      canonical parent runtime scope and complete semantic map.

      _Recommended fixtures:_ `01_comprehensive_metadata.jpg` for the broad identity mix, `02_ifd0_ifd1_shared_schema.jpg` for shared schemas, and `06_langalt_description.jpg` for flattened LangAlt members.

## Shared-schema occurrence and target checks

- [ ] **15. Prepare shared-schema occurrences.** Use a disposable file
      containing two existing occurrences that resolve to one schema, such as IFD0
      and IFD1 `XResolution`. Confirm the occurrences have distinct
      document/path/runtime-ID/scope/copy coordinates as applicable while sharing
      the schema definition.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`.

- [ ] **16. Edit each shared-schema occurrence independently.** Stage and apply
      a different value to IFD0, verify readback, then repeat for IFD1. Expected:
      each draft retains its own complete occurrence and write-target snapshot; the
      sibling is unchanged.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`.

- [ ] **17. Inspect generated selectors and readback.** For both shared-schema
      edits, confirm the generated selector identifies the intended runtime
      destination, for example `1IFD0:7ID-282:XResolution` versus
      `1IFD1:7ID-282:XResolution`, and independent ExifTool readback changes only
      that occurrence.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`.

- [ ] **18. Audit target-first behaviour.** Exercise staging, apply,
      verification, retry and discard for the shared-schema fields. Expected: no
      step first-selects an existing occurrence by `SchemaDefinitionId`; schema
      projections may support deliberate read-only semantic views but never target
      selection.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`.

## New Property destination checks

- [ ] **19. Exercise the destination combobox.** Confirm the schema default
      appears first, suggestions are deduplicated, keyboard selection works, and an
      unknown valid token can be typed. Confirm `1IFD0`, whitespace, colons, equals
      signs and control characters disable Next with a precise error.

- [ ] **20. Create same-schema destination drafts.** Stage New Property for one
      exact schema at two valid family-1 destinations. Expected: both drafts
      coexist, both complete selectors remain visible, reopening restores each
      stored group, and neither overwrites the other.

- [ ] **21. Check destination occupancy.** With an observed existing IFD0
      selector whose `write_target` is null and whose schema differs from the
      proposed property, confirm the exact IFD0/family-7/name destination is blocked
      before any write. Confirm a same-schema occurrence lacking a safely
      represented observed selector remains conservatively blocked.

      _Recommended fixture:_ start from `02_ifd0_ifd1_shared_schema.jpg` for occupied IFD0/IFD1 resolution selectors; use controlled draft or harness setup for the cross-schema and missing-selector states.

- [ ] **22. Force verification failures on disposable files or the fake-client
      harness.** Expected: redirected family 1, changed runtime family 7 or tag
      name, changed schema index, missing result and duplicate exact results retain
      the draft and record the attempted selector plus observed occurrence/schema
      identities.

      _Prepared-fixture note:_ no image in the pack directly provides every redirected, changed, missing and duplicate result; use the fake-client harness or controlled external changes.

- [ ] **23. Check family-7 case handling.** Exercise two otherwise identical
      selectors whose family-7 IDs differ only by case, such as `ID-AbC` and
      `ID-abc`. Expected: they remain distinct, while family-1 and tag-name case
      differences compare equal.

      _Prepared-fixture note:_ no image in the pack provides case-only family-7 selector variants; use the fake-client harness.

- [ ] **24. Move a destination.** Stage one New Property draft at IFD0, choose
      **Edit destination…**, change it to IFD1, and save. Expected: exactly one
      draft exists before and after; the selector changes to IFD1 and the semantic
      value is unchanged.

- [ ] **25. Fail a destination move.** Attempt a move to an occupied occurrence
      selector and to another pending draft selector. Expected: the dialog remains
      open, the original target/value remain intact, and no replacement slot is
      created. Confirm a pending verification outcome also blocks the move until
      resolved.

      _Recommended fixture:_ start from `02_ifd0_ifd1_shared_schema.jpg` for an occupied destination; stage another pending destination and use the harness for the pending-verification variant.

- [ ] **26. Separate New Property value and destination edits.** Stage a New
      Property with a custom destination. Use **Edit value…** to change only its
      value and confirm the selector is unchanged. Then use **Edit destination…**
      to change only its group and confirm the value is unchanged. With a
      same-schema sibling destination staged, confirm both operations leave the
      sibling untouched.

- [ ] **27. Preserve a custom GPS destination.** Add a GPS property using a
      custom destination group, stage a value, reopen it with **Edit value…**, and
      change the value. Expected: the destination remains unchanged, and no paired
      GPS fields or default destination are introduced.

      _Recommended fixture:_ `04_no_gps_real_file.jpg`, where GPS is deliberately absent.

## Occurrence-first Details and removal checks

- [ ] **28. Inspect occurrence-first grouping.** Use a file containing IFD0 and
      IFD1 occurrences of one schema. Expected: each is a separate row in its
      observed family-1 group, even when values are equal. No special
      additional-occurrence section appears.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`.

- [ ] **29. Inspect fallback grouping.** Open a file with an unresolved local
      `TagInfo`, if available. Expected: the occurrence remains visible under a
      clear schema-table fallback group with complete diagnostics and read-only
      behaviour.

      _Prepared-fixture note:_ the pack has no guaranteed unresolved local `TagInfo`; use the fake-client harness or prepare an additional disposable image.

- [ ] **30. Inspect inline New Properties.** Stage two same-schema New
      Properties at different destinations, including one custom group. Expected:
      each appears inline under its stored destination with **New** status; neither
      appears in a special target-aware section or inherits the schema default
      group.

- [ ] **31. Inspect a stale target.** Leave an ExistingOccurrence draft, then
      alter a disposable file so the occurrence schema or selector snapshot
      changes. Expected: the current occurrence row remains visible with
      **Stale target** status, the staged value is not overlaid, no sibling is
      selected, and exact discard remains available.

      _Recommended fixture:_ `09_external_alter_target.jpg`; use `change-value-after-staging.ps1` after staging.

- [ ] **32. Inspect missing and duplicate targets.** Remove an occurrence behind
      a stored draft, and separately exercise the duplicate-ID fake-client case.
      Expected: the stored operation appears as a target-only warning row. Only
      actions safe for the complete stored target are offered.

      _Recommended fixture:_ `09_external_alter_target.jpg`; use `remove-staged-occurrence.ps1` for the missing target and the fake-client harness for the duplicate target.

- [ ] **33. Check exact group removal.** In one displayed group containing
      writable occurrences and pending New Properties, invoke group removal.
      Expected: only exact targets assigned to that group are affected; read-only
      rows are not counted. IFD0 removal does not widen to an IFD1 same-schema
      sibling, and a custom New Property destination is cancelled only from its
      custom group.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`; stage the pending New Properties needed by the check.

- [ ] **34. Check full-group behaviour under search.** Filter Details so one GPS
      or metadata row is hidden, then open the map or group context menu. Expected:
      map data, removal and discard still use the complete unfiltered group.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg` for its complete GPS group.

- [ ] **35. Check exact individual GPS editing under ambiguity.** Use a fixture
      with two GPS occurrences sharing one schema. Expected: grouped
      **Edit GPS…** is disabled when the six-member set is ambiguous, while an
      individually targetable occurrence can still be edited by its captured exact
      target and the sibling remains unchanged.

      _Prepared-fixture note:_ the pack has no image with two ambiguous GPS occurrences sharing one schema; use the fake-client harness or prepare an additional disposable image.

## Latest Details presentation and draft-state checks

- [ ] **36. Inspect occurrence-row labels and qualifiers.** Use a file containing
      one occurrence with a non-zero copy number, followed by a file containing two
      rows with the same visible property label. Expected: the sole occurrence does
      not gain an unnecessary suffix. Duplicate visible labels gain only enough
      origin information to distinguish them, progressively using runtime identity
      where necessary.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg` for duplicate visible resolution labels. The pack has no non-zero-copy single-occurrence fixture; use the harness or another image for that half.

- [ ] **37. Inspect curated row tooltips.** Hover the property-name and value
      cells of an ordinary occurrence, an edited occurrence, a New Property and a
      missing-occurrence warning. Expected: the name tooltip labels property,
      runtime families, schema identity, schema datatype and writability,
      editability, status and reason. The value tooltip separately labels current
      value/type, draft action, staged value/type, compatibility and preview
      errors. Multiline values remain readable and do not create unlabelled lines.

      _Recommended fixtures:_ `01_comprehensive_metadata.jpg` for ordinary, edited and New Property rows, plus the missing-target state produced from `09_external_alter_target.jpg` in check 32.

- [ ] **38. Check embedded and fallback tag information.** Inspect several
      occurrences sharing one schema, including a New Property for that schema.
      Expected: embedded `TagInfo` is available immediately and consistently;
      deferred schema lookup does not cause rows to flicker, lose their label or
      become temporarily misclassified. An unresolved occurrence remains visible
      and read-only rather than inheriting information from a sibling.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg`; stage a New Property for the same schema.

- [ ] **39. Preserve staged display formatting.** Stage edits to an enum or
      otherwise specially formatted field, then navigate away, return to the file
      and restart the application. Expected: the staged row retains the user-facing
      display label rather than falling back to a raw numeric or encoded value.

      _Recommended fixtures:_ `07_orientation_enum.jpg` primarily and `08_flash_bitfield.jpg` additionally.

- [ ] **40. Exercise list-operation previews.** Test replacement, add and remove
      operations for an ordinary text list and, where available, a structured or
      rational list. Also exercise a scalar value encountered beneath a list
      schema. Expected: the staged display and datatype badges describe the
      effective result that would be written, add/remove equality follows semantic
      rather than display-string equality, and reopening the editor seeds the
      effective staged value.

      _Recommended fixture:_ `05_lists_xmp_iptc.jpg` for ordinary text lists. The pack has no structured/rational-list or scalar-beneath-list fixture; use the fake-client harness for those cases.

- [ ] **41. Inspect an unsupported staged preview.** Using a disposable draft
      file or test harness, create a staged payload that cannot be applied to the
      row's current value or schema. Expected: the authoritative current value
      remains displayed, the row reports **Staged preview unavailable**, and the
      state is not presented as deletion or as a valid replacement. Editing is
      blocked, but exact discard remains available.

      _Prepared-fixture note:_ no image alone creates an unsupported staged payload; use a disposable draft file or the fake-client harness.

- [ ] **42. Show every pending selector conflict.** Create two or more pending
      New Properties whose destinations collide. Exercise family-1 and tag-name
      case-only differences, and separately family-7 values that differ only by
      case. Expected: family 1 and tag name compare case-insensitively; family 7
      remains case-sensitive. Every conflicting draft remains visible as its own
      row. Each can be discarded or have its destination edited without silently
      deleting or retargeting another draft.

      _Prepared-fixture note:_ no image alone creates the required pending-selector collisions; use controlled draft data or the fake-client harness.

## Persistence, apply and verification checks

- [ ] **43. Fail target-draft loading safely.** In a disposable app-data copy,
      replace one SQLite `entries_json` value with malformed JSON, then open its
      folder. Expected: the load error is surfaced, all property mutation and
      Apply actions are disabled, and no draft row is rewritten or removed.
      Switching to a valid folder restores normal operation. Returning after
      repairing the row loads normally.

- [ ] **44. Exercise incremental apply and cancellation.** Stage edits across
      several files, including at least one file with multiple edits. Start Apply
      and cancel after one or more files have completed. Expected: progress counts
      update incrementally; completed files receive authoritative rereads and clear
      only reconciled drafts; unprocessed or failed files retain their drafts.
      Cancellation does not duplicate diagnostics or undo completed files.

      _Recommended fixtures:_ `10_batch_york_existing_description.jpg`, `11_batch_cambridge_existing_description.jpg`, `12_batch_london_existing_description.jpg` and `13_batch_york_missing_description.jpg`.

- [ ] **45. Exercise every verification reconciliation state.** Using
      disposable file changes or the fake-client harness, produce Clear, Keep,
      Replace and Blocked outcomes. Expected: each verification row identifies the
      complete original and replacement target where applicable. Accepting current
      or written state removes only the corresponding exact outcome and draft;
      keeping the draft dismisses only the outcome; discarding removes only the
      exact pending target. Blocked outcomes offer no unsafe acceptance or
      automatic repair. Same-schema siblings remain untouched.

      _Recommended fixture:_ use `09_external_alter_target.jpg` for controlled file changes and the fake-client harness to cover all four reconciliation states.

- [ ] **46. Inspect the target-aware apply audit.** Apply edits to an
      ExistingOccurrence and a New Property, including one custom destination.
      Expected: `MediaLibraryTargetApplyLog.jsonl` appends records containing the
      intended complete target, selector, schema and verification result. Existing
      rows remain unchanged. If historical `MediaLibraryApplyLog.jsonl` or
      `MediaLibraryDraftEdits.jsonl` files are present, confirm they remain
      byte-for-byte untouched.

      _Recommended fixture:_ `01_comprehensive_metadata.jpg`.

## Multi-file removal and generated-workflow checks

- [ ] **47. Remove one field across selected files.** Select several files
      containing a mixture of a unique existing occurrence, an absent field, a
      pending New Property, an already-staged Delete and, if practical, an
      ambiguous or stale target. Expected: the preview distinguishes exact
      deletion, creation cancellation and no-op. One unsafe selected file blocks
      the complete operation before mutation. After confirmation the operation
      replans against current state and either commits one atomic target-draft
      change or none. Same-schema sibling occurrences are not widened into the
      removal.

      _Recommended fixtures:_ `01_comprehensive_metadata.jpg`, `02_ifd0_ifd1_shared_schema.jpg` and `13_batch_york_missing_description.jpg`; stage the required New Property, Delete and stale states first.

- [ ] **48. Run AI Description through target-aware staging.** Use multiple
      disposable files containing a mixture of an existing AI field, a missing
      field and a same-schema ambiguity. Expected: the overwrite warning reflects
      effective staged metadata; unique existing fields become exact
      ExistingOccurrence drafts; missing fields become deliberate New Properties;
      ambiguous files fail without selecting the first occurrence. An empty backend
      result succeeds without errors, notifications or saves. A staging failure for
      one file is reported while later files continue.

      _Recommended fixtures:_ files `10_batch_york_existing_description.jpg` through `13_batch_york_missing_description.jpg`; add controlled same-schema ambiguity with the harness.

- [ ] **49. Run Reverse Geocode through effective GPS state.** Test
      authoritative coordinates, staged coordinate edits, staged reference
      changes, W/S coordinates, signed zero and a file without usable GPS.
      Expected: the confirmation input, gallery map and backend payload agree;
      hemisphere references are preserved; overwrite warnings include effective
      staged location metadata; generated edits land on exact targets. A no-GPS
      file is reported without aborting later files.

      _Recommended fixtures:_ files `10_batch_york_existing_description.jpg` through `13_batch_york_missing_description.jpg`, plus `03_zero_south_west_gps.jpg` for signed-zero S/W and `04_no_gps_real_file.jpg` for no GPS.

- [ ] **50. Run Normalise with an immutable group selection.** Select a subset
      of normalisation groups, confirm the operation, then change the visible
      checkbox state while results are in flight if the UI permits. Expected:
      backend input and result allowlisting continue to use the originally
      confirmed group snapshot. Existing target drafts influence normalisation
      input and overwrite warnings. A failure or ambiguous target in one file does
      not partially stage that file and does not stop later files.

      _Recommended fixtures:_ files `10_batch_york_existing_description.jpg` through `13_batch_york_missing_description.jpg`; use the harness for an ambiguous target.

- [ ] **51. Recheck generated-workflow readiness at confirmation.** Open the
      confirmation stage for Describe, Reverse Geocode and Normalise, then make the
      folder's occurrence or target-persistence state unavailable before pressing
      Confirm, using a controlled harness or lifecycle reproduction. Expected: the
      backend job does not start, the confirmation dialog remains available for
      cancellation or retry, and a normal application error is surfaced.

      _Prepared-fixture note:_ no image alone produces the required lifecycle failure; use the controlled harness or lifecycle reproduction.

- [ ] **52. Check search and read-only projections after exact edits.** Search by
      staged value, row status and target diagnostics, then discard the final
      matching draft. Expected: search updates immediately and the stale hit
      disappears. For same-schema occurrences with conflicting values, Details
      continues to show every occurrence while schema-oriented columns, sorting
      and generated inputs do not arbitrarily select one.

      _Recommended fixture:_ `02_ifd0_ifd1_shared_schema.jpg` after staging distinct exact edits.

## Exploratory GPS creation check

- [ ] **E1. Explore adding GPS to a file with no GPS group.** Determine whether
      the grouped GPS editor has a discoverable entry point when none of its six
      fields exists. Record the actual behaviour rather than assigning a pass/fail
      expectation. If creation is supported, confirm all created fields use
      deliberate complete New Property targets and that reopening the editor
      resolves the newly created exact set.

## Suggested execution passes

1. **Basic editing:** checks 1-14.
2. **Identity and destinations:** checks 15-27.
3. **Occurrence-first UI and removal:** checks 28-42.
4. **Persistence and apply failures:** checks 43-46.
5. **Multi-file and generated workflows:** checks 47-52.
6. **Exploratory behaviour:** E1.

Within each pass, execute normal success cases before corruption, stale-target,
duplicate-ID and forced-verification cases.

# Exact-ID manual validation

This checklist supplements automated schema, occurrence and write-target
identity tests. It has not been executed as part of this change.

Use a disposable copy of a representative photo folder containing JPEG files
with EXIF, XMP, IPTC, GPS, list and LangAlt metadata. Keep the application log
open and do not use irreplaceable originals.

1. **Scan the folder.** Confirm every supported photo appears and metadata
   loading completes without schema-gap errors for ordinary fields.
2. **Inspect common fields.** In Details, inspect ordinary EXIF, XMP, IPTC and
   GPS values. Expected: values and datatypes match an independent ExifTool
   read; table/ID diagnostics identify the exact definitions.
3. **Search.** Search by a friendly property name, description and value.
   Expected: matching photos appear, while same-name definitions remain
   independently searchable by their displayed table context.
4. **Add a property.** Use Add New Property and explicitly select one result.
   Expected: the chosen row shows table/ID context and only that exact
   definition receives a draft.
5. **Edit text and apply.** Change a writable scalar text field. Expected: the
   readback value matches and the draft clears only for the selected exact ID.
6. **Edit a list.** Replace a writable text list, then exercise add/remove.
   Expected: items remain separate, with correct replacement/add/remove
   semantics after readback.
7. **Edit GPS.** Change latitude, longitude and their reference fields
   together. Expected: the map position and each exact GPS field agree after
   readback.
8. **Edit LangAlt.** Where available, set `x-default` and another language.
   Expected: both values reread beneath the single exact LangAlt parent.
9. **Restart with drafts.** Leave unapplied drafts, close and reopen the same
   folder. Expected: target drafts reappear against the same exact occurrences
   or New Property definitions.
10. **Inspect read-only collision.** Scan or open one Windows BMP and one OS/2 BMP. Inspect `File:BMPVersion` in the Details Pane. Expected: Windows resolves to `BMP::Main/0`, OS/2 resolves to `BMP::OS2/0`, both are read-only, and identical friendly labels do not cause either definition to replace the other.
11. **Inspect writable collision.** In Add New Property, where the current ExifTool registry contains multiple writable definitions sharing a friendly label, confirm each result displays table, tag ID and optional index separately. (If no suitable writable collision is present in that ExifTool version, record this sub-check as not applicable).
12. **Try unknown/read-only fields.** Expected: editor and apply actions are unavailable; missing schema is never treated as writable.
13. **Inspect apply/readback outcomes.** Apply a mixed set of edits. Expected: every success, mismatch or retained draft names the intended exact table, tag ID and optional index.
14. **Inspect the identity layers.** For representative existing fields, use available diagnostics or logs to record the friendly label, raw `RuntimeTagIdScope`, resolved `SchemaDefinitionId`, complete `MetadataOccurrenceId`, and `MetadataWriteTarget`. Expected: each is shown in its own role; a LangAlt child may retain a child runtime scope while resolving to the parent schema.
15. **Prepare shared-schema occurrences.** Use a disposable file containing two existing occurrences that resolve to one schema, such as IFD0 and IFD1 `XResolution`. Confirm the occurrences have distinct document/path/runtime-ID/scope/copy coordinates as applicable while sharing the schema definition.
16. **Edit each shared-schema occurrence independently.** Stage and apply a different value to IFD0, verify readback, then repeat for IFD1. Expected: each draft retains its own complete occurrence and write-target snapshot; the sibling is unchanged.
17. **Inspect generated targets and readback.** For both shared-schema edits, confirm the generated selector identifies the intended runtime destination (for example `IFD0:XResolution` versus `IFD1:XResolution`) and independent ExifTool readback changes only that occurrence.
18. **Audit selection behaviour.** Exercise staging, apply, verification, retry and discard for the shared-schema fields. Expected: no step first-selects an existing occurrence by `SchemaDefinitionId`; schema grouping may support read-only presentation but never target selection.

Do not add or mark passed a New Property same-schema destination scenario yet.
That creation behaviour is intentionally deferred to a separate design
decision.

On failure capture the file format, application version/commit, ExifTool
version, friendly label, exact `{table, tag_id, index?}`, intended and observed
semantic values, apply/readback outcome, and the relevant application log. Do
not attach an original photo when a redacted disposable reproduction is
sufficient.

Current
=======

- Check all photos at the end
  - Any missing GPS?
  - Any missing description/keywords?
  - Any missing dates?

Bugs/quirks/tweaks/improvements
=================================

- Some image thumbnails are rotated
- If order of photos changes whilst in the gallery (e.g. metadata finishes loading), it can change which photo you're looking at!
- Clarify behaviour when metadata fails to load for a photo. Currently we show no metadata for the photo at all, but potentially we could show just the ones that loaded successfully etc.
  - What about if you make a draft edit and try to apply it when the metadata has failed? Is that safe?
- If open a parent/child folder, the drafts database etc. won't be found. COuld be conflicting. Maybe we should always make a database in the folder of the photo, not the folder that was opened. Then it's always consistent no matter what folder you open
- Loading metadata is slow for large folders, maybe need to cache this in a local db file. Need a way to tell if out of date, e.g. file timestamp changed or some kind of hash?
- Loading thumbnails might be slow for large folders, maybe need to cache this in a local db file. Need a way to tell if out of date, e.g. file timestamp changed or some kind of hash?
- Disable text-select as it messes up selection of file rows? Maybe have a key to press to re-enable it as it can be useful to copy things

Features
========

- BATCHING OR FLEX for half-price API?
- Multi-batch chaining context
  - Carry summary/context from one batch into the next, mainly for AI/geographic/theme continuity.
- Suspicious GPS detection
  - Detect near-identical GPS clusters across many photos, especially where dates/visual context suggest they should differ.
- Visual/location correction proposals
  - Optional, cautious flow for “this GPS/location looks wrong; here is a suggested correction”, probably report-first rather than auto-writing.
- Date anomaly review
  - Add validators for filename-vs-metadata mismatch, suspicious duplicate timestamps, and maybe “metadata date wildly inconsistent with folder/date context”.
- Combined image + metadata AI review, only if practice shows the split pipeline is weaker
  - This is the main architectural difference, but not necessarily a required gap unless results are worse.
- Feature to fill in missing GPS location based on description/tags (which could itself have been AI-generated from the visual content). Could also be used to fix batches of photos all clustered to the exact same GPS location (e.g. by a coarse previous manual edit). e.g. 2010 london photos, or where incorrect GPS was recorded
- Feature for facial/person recognition?
- Support deletion of photos (make sure all the various in-memory stores are updated)
- Reload/refresh folder button? (Equivalent to close + open)
- Audio/video support
  - Check audio/video player in gallery works
  - A better gallery experience would handle <audio>/<video> error events and show a clear message such as:
  - Thumbnails:
    - audio: embedded album artwork?
    - video: embedded thumbnail or generated frame?
  - Kind-based search and filtering
  - Media kind badge (or similar) on files
  - Column selections probably want to be different - different defaults, remember last-used in separate place
    - Could auto-detect if this is a "picture" folder or a "audio" folder and make a few tweaks based on that
  - Normalize metadata could but might need new groups defining.

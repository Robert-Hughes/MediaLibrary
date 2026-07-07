Current
=======

Bugs/quirks/tweaks/improvements
=================================


Features
========

- Ability to force normalisation, even if it thinks already done. This is useful for Description, if an AI Description was generated after the normal description already normalised
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
- Map view, showing locations of all photos/heatmap over the map
- Feature for facial/person recognition?
- Support deletion of photos (make sure all the various in-memory stores are updated)
- Reload/refresh folder button? (Equivalent to close + open)
- Consider adding FLAC support. Not sure what this would mean.
  - Exiftool already supports FLAC (and other audio formats), so a lot of stuff should "just work"
  - Where in the app do we use the word photo/image/picture/jpeg/etc
  - Basic audio player for the gallery view (no auto-play, no auto-advance to next track on finish, just enough to show the user which track this is)
  - Column selections probably want to be different - different defaults, remember last-used in separate place
    - Could auto-detect if this is a "picture" folder or a "audio" folder and make a few tweaks based on that
  - AI describe, reverse geocode don't apply. But normalize metadata could but might need new groups defining.
- How are videos handled by exiftool? Can we?

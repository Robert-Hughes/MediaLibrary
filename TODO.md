Current
=======

- WHy is npm run check so slow!
- Use (interactive) OSM iframe/API to show GPS location
  - In GPS editor UI, along with clicking to overwrite with that location for editing
    - Figure out how the group edit thing works - editing some fields like Altitude doesn't show the composite editor!
  - In Details pane next to the GPS section?
    - Clicking on the small maps should open the full map (as below)
    - Right click on maps with edit (opens group editor) and "remove all GPS". Or maybe for the group heading? Make it work for all groups (not just GPS)?
  - Select a bunch of photos, right click, "show on Map" opens map popup with pins/thumbnails for each photo
- Add bulk tag editor
  - Choose a tag name
  - Choose Overwrite/Delete/Update
  - Choose further options like new value, add or remove from set etc.
  - Use existing editors/routing
  - Composite editors like GPS?
  - remove right click option on the headers once we have this
- 2010 folder (and possibly others)
  - Remove all description/title/keywords fields so can be regenerated
  - Remove wrong GPS data (coords + the lower-level geocoded fields, leave higher-level London, UK etc.) from photos (several different clusters)
    - Could manually set rough locations in string fields e.g. using bulk tag editor
  - AI Description on all photos that don't have it
  - Normalise for everything

Bugs/quirks/tweaks/improvements
=================================

- Some image thumbnails are rotated

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
- Easier GPS editing (e.g. search by address or by map)
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

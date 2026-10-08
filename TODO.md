Current
=======

- Home address number is off-by-two in reverse-geocoded/tagged metadata; review and correct the textual location metadata, maybe fix for future too, perhaps well-known locations?
- incorrect descriptions etc.
  - P2080807 is not a kangaroo!
  - MSGR_PHOTO_FOR_UPLOAD_1525725143418 not a fox
  - 1503780879913 not a rabbit
  - Some st. pauls photos misidentified objects?
  - The Windsor close-up is the Curfew Tower, despite its description calling it the Round Tower
- Any missing dates?
  - Panasonic camera's timestamp seems to be off by one hour - fix all?
  - Wedding photos from 2026 have wrong date! Check others?
  - Anything whjere date doesn't match folder, or is out of sync with another date or nearby photos etc.
  - Facebook messenger photos tend to be bad for this
  - 1500122345839 is a Unix timestamp in milliseconds
- Move out of Unknown folder? (and AI describe, normalize etc., not touched these at all yet!)
- Confirm all are "normalised"
  - Have GPS, date, description/keywords and pass normalise test
- Try out some searches across fuill collection!
- Try out the GPS view across the full collection!
- Check all videos, as we probably didn't process all these properly yet
- Delete "Update Metadata Scripts" folder?

Bugs/quirks/tweaks/improvements
=================================

- Copying to clipboard doesn't seem to go into Win+V only from this app??

Features
========

- GPS map editor could show draft location as well as the file's location (crossed out)
- Search by approx GPS location, inc. a "near this photo" search
- XMP-exif GPS coords (separate to GPS::MAIN EXIF fields that we currently use). This would allow other file formats like .gif to support GPS properly.
- BATCHING OR FLEX for half-price API?
- Multi-batch chaining context
  - Carry summary/context from one batch into the next, mainly for AI/geographic/theme continuity.
- Date anomaly review
  - Add validators for filename-vs-metadata mismatch, suspicious duplicate timestamps, and maybe “metadata date wildly inconsistent with folder/date context”.
- Combined image + metadata AI review, only if practice shows the split pipeline is weaker
  - This is the main architectural difference, but not necessarily a required gap unless results are worse.
- Feature to fill in missing GPS location based on description/tags (which could itself have been AI-generated from the visual content). Could also be used to fix batches of photos all clustered to the exact same GPS location (e.g. by a coarse previous manual edit). e.g. 2010 london photos, or where incorrect GPS was recorded
- Feature for facial/person recognition?
- Audio/video support
  - A better gallery experience would handle <audio>/<video> error events and show a clear message such as:
  - Thumbnails:
    - audio: embedded album artwork?
    - video: embedded thumbnail or generated frame?
  - Media kind badge (or similar) on files
  - Column selections probably want to be different - different defaults, remember last-used in separate place
    - Could auto-detect if this is a "picture" folder or a "audio" folder and make a few tweaks based on that.
    - QuickTime:CreateDate instead of DateTimeOriginal for example
  - Normalize metadata could but might need new groups defining.

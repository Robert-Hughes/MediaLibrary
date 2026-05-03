!!! Make sure to add/update good test coverage for each change. Make sure that all user-facing features
are covered by integration tests that simulate UI interaction and confirm that the DOM and/or app state updates as expected.
!!! Make small, incremental commits to git. Try to avoid mixing different features or bits of work within the same commit where possible

Now
===

* List view - implement (multi-)selection. Single click to select, double click to open in gallery.
* Sync the selected row with the gallery view, i.e. navigating left/right in the gallery will also move selection up/down in the list (and scroll the newly selected image into view as necessary)
* List view context menu when right clicking on a row:
    * View (opens in gallery, equivalent to double-click)
    * Show in File Explorer


Later
=====

* Metadata should be gathered via:
        You wanted to see only the data physically stored in the file, excluding OS-level info (System) and ExifTool calculations (Composite).

        Command:

        powershell
        exiftool -a -G1 -s --system:all --composite:all "D:\OneDrive\Pictures\2007\IMG_1998.jpg"

        Use -j for JSON

* Writing metadata and Normalization
We discussed why your workflow uses explicit tag names instead of generic shortcuts.

Surgical (Your Workflow):
powershell
exiftool -XMP-dc:Description="New" -IPTC:Caption-Abstract="New" image.jpg
Rationale: By being specific, you ensure that every layer of the metadata "sandwich" (EXIF, IPTC, XMP) is perfectly synchronized and follows the standards defined in your project instructions.

* Editing metadata - store draft/proposed changes locally (not in the files). THen a button with confirmation to apply the changes and confirm application was successful.
* Using OpenAI API to analyze image contents
* Combine image description with other metadata (and 'storyline') to propose changes to metadata. This could be a mix of programmatic and Open AI Responses API?
* Compare with functionalty of the Update Metadata prompts approach - add anything missing to here?

* Gallery view - improve general responsiveness

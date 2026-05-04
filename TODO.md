!!! Make sure to add/update good test coverage for each change. Make sure that all user-facing features
are covered by integration tests that simulate UI interaction and confirm that the DOM and/or app state updates as expected.
!!! Make small, incremental commits to git. Try to avoid mixing different features or bits of work within the same commit where possible

Now
===

* Bug: There's a small gap between the two "rows" in the list view column headings, leading to table rows being visible through the gap when scrolling down
* Store Image metadata as arbitrary key-value pairs, key as string, value as a 'Variant' type, rather than the two hardcoded metadata fields we currently handle (OS metadata fields can remain hardcoded as it is now)
* Variant value type should be able to handle strings, numbers and lists of variants
* We don't want to show all the available Image metadata in the list view columns - let's have a default set of a couple of well-known Image metadata keys that we show, and the others will be hidden by default.
* There will be a "Select Columns..." button to show a dialog where the user can choose to show/hide columns, with a full list of all the available Image metadata keys
    * This will be taken from the union of the Image metadata keys across all images (cache this, don't compute it each time!)
    * This dialog should show, for each unique Image metadata key, how many of the loaded images have a value for that key (so the user can identify which Image metadata keys will be useful to show)
* Metadata should be gathered via a method that retrieves the data physically stored in the file, excluding OS-level info (System) and ExifTool calculations (Composite).
    Use this command:

        exiftool -a -G1 -s --system:all --composite:all -j <path to jpg>

    Include code comments to explain what these parameters do and why we're using them.
    We can remove the Rust crate dependency that we're currently using to load EXIF metadata
    This will output a JSON file that the Rust code should parse and store in the Image metadata, converting from JSON strings/numbers/lists to our Variant type.


Later
=====

* Allow showing/hiding of OS Metadata columns too, in the columns dialog
* Persist the users choice of columns across app sessions


* The gallery view that shows a single image should have a details pane on the right hand side which shows a big table of all the properties of the image, including
all the Image metadata.

* The details table in the gallery view should have a search feature (to search both keys and values)
* The list view should have a search feature (to search the path, OS metadata and Image metadata for all the images, including the Image metadata not currently being shown)
* When the list view is filtered via a search, the navigation in the gallery mode should sync with this (i.e. next/prev moves to the next/prev in the filtered search results)

* The app should allow editing of metadata. For now, edits will be kept just as 'draft' changes and not actually applied to the files on disk.
    * We should store in the app's local storage a database of draft edits. For each folder that the user has opened and made draft edits, we'll store a separate
    file that contains all the draft edits the user has made for files in that folder. The format would be something like a JSONL file with line for each file where there are draft edits
    and each line contains a dict of properties to the proposed new values
    * This file should be kept in sync as the user makes edits in the UI, in case the program crashes
    * When loading a folder, check if our local database already has draft edits from a previous session, and load it
    * The draft edits should be clearly noted in the list view's column values, showing the original value with a strikethrough and the proposed new value
      written afterwards highlighted in bold.
    * The draft edits should also be clearly noted in the gallery view's details table, showing the original value with a strikethrough and the proposed new value
      written afterwards highlighted in bold.
    * New edits can be made in the gallery view's details table by right clicking on a value cell in the table and selected "Edit", which will show a popup dialog prompting for the new value.
    * At the top of the list view where it currently shows "X photos", it should also show the number of pending draft edits, something like: "X photos, Y draft edits across P files". (Clearly
    this would just count edits for files in the current folder).



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
* Figure out how exiftool should be bundled/installed/etc.
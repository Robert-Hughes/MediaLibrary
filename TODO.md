Now
===

* Scaffold the initial app structure
    * The user opens/selects a folder from a folder browser and the app then shows information about all the photos in that folder (and subfolders, recursively)
    * For now let's just show the filename (relative to the opened root folder) and a thumbnail.
    * There might be many thousands of photos, so the data processing needs to be asynchronous and the UI needs to stay responsive
     whilst data is loaded, and give a clear indication to the user that processing is still occuring and what data is loaded and what data is still being loaded
    * For now a simple 'details' list view (like you get in Windows explorer) is fine.
    * The user can choose to close the current folder (revert the app to default state), or open a new folder instead (replace the list
     with that from the new folder)
* Theming - aim for a technical and functional look.

Later
=====

* Double clicking image to open the full version in a 'gallery' view, left and right arrows on this full view to switch photos. Important that the order of photos in the gallery view matches that of the main list and that the positions are synced - make sure to test this explicitly.
* Add more columns to the list view. The columns should be grouped:
    * Outer metadata (i.e. properties *of* the file stored by the OS, not the internal EXIF metadata stuff)
        * Filename
        * Date modified
        * Date created
    * Inner metadata (i.e. properties *inside* the file, like EXIF metadata)
        * DateTaken (DateOriginal or whatever it's called)
        * Camera model
        * etc.

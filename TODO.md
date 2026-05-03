!!! Make sure to add/update good test coverage for each change. Make sure that all user-facing features
are covered by integration tests that simulate UI interaction and confirm that the DOM and/or app state updates as expected.
!!! Make small, incremental commits to git. Try to avoid mixing different features or bits of work within the same commit where possible

Now
===

* When a folder is already open, move the Open Folder and Close buttons to a menu bar at the top 
* When a folder is open, move the display of the folder name to the window title
* Get rid of the Space and Escape keyboard shortcuts
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


Later
=====



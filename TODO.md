!!! Make sure to add/update good test coverage for each change. Make sure that all user-facing features
are covered by integration tests that simulate UI interaction and confirm that the DOM and/or app state updates as expected.
!!! Make small, incremental commits to git. Try to avoid mixing different features or bits of work within the same commit where possible

Now
===

* Show in bottom panel/top when metadata still loading
* spinner animations should all synced together
* Metadata loading queue should be prioritised based on list position, like we do for thumbnails. Though the thumbnail priority seems to be broken atm! FIx this too
* Bug - Pressing Close when still loading doesn't stop loading - the list is cleared but more photos appear!  (Presumably a similar bug is present when switching to a different folder?)
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

* List view - implement (multi-)selection. Single click to select, double click to open in gallery.
* Sync the selected row with the gallery view, i.e. navigating left/right in the gallery will also move selection up/down in the list (and scroll the newly selected image into view as necessary)
* Gallery view - improve general responsiveness
* Recent folders saved and shown on the home screen when no folder is open

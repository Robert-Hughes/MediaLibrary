Now
===



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

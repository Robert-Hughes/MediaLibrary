* Scaffold the initial app structure
    * The user opens/selects a folder from a folder browser and the app then shows information about all the photos in that folder (and subfolders, recursively)
    * For now let's just show the filename (relative to the opened root folder) and a thumbnail.
    * There might be many thousands of photos, so the data processing needs to be asynchronous and the UI needs to stay responsive
     whilst data is loaded, and give a clear indication to the user that processing is still occuring and what data is loaded and what data is still being loaded
    * For now a simple 'details' list view (like you get in Windows explorer) is fine.
    * The user can choose to close the current folder (revert the app to default state), or open a new folder instead (replace the list
     with that from the new folder)
* Theming - aim for a technical and functional look.

Completed:
- Basic app structure with state management (Default, Loading, Loaded)
- Folder selection using rfd
- Asynchronous scanning and thumbnail loading in background thread
- Progress indication during loading
- List view with thumbnails and filenames
- Buttons to close or open new folder
- Dark theme with black background and white text
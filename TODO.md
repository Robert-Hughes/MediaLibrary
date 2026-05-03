* Scaffold the initial app structure
    * The user opens/selects a folder from a folder browser and the app then shows information about all the photos in that folder (and subfolders, recursively)
    * For now let's just show the filename (relative to the opened root folder) and a thumbnail.
    * There might be many thousands of photos, so the data processing needs to be asynchronous and the UI needs to stay responsive
     whilst data is loaded, and give a clear indication to the user that processing is still occuring and what data is loaded and what data is still being loaded
    * For now a simple 'details' list view (like you get in Windows explorer) is fine.
    * The user can choose to close the current folder (revert the app to default state), or open a new folder instead (replace the list
     with that from the new folder)
* Theming - aim for a technical and functional look.

I'd like to add some tests based on the UI state.

If I'm correct, the rendered UI is dependent entirely on some state data, and so we can test if this state data gets mutated in expected ways based on user input and background work that the app does.

I'm thinking of tests along the lines of:

Check default app state is as expected
Open a folder and wait for loading to finish, check app state shows the expected list of files
This might require some refactoring of the code to separate out a clean view-model state object, which would be a good thing
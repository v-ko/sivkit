# Repo tracking of full content and blobs
Like in Git - there's text content and lfs stores. We want to keep close to the philosophy of owning your data and have file-system-first storage. But we also want to track changes for the purpuses of doing e,g. undo-reverts and communicating changes efficiently.

Some files will contain fully tracked content (possibly broken down into object with schemas), like canvas and markdown pages. And others will be considered blobs - like images and other media. Blob storage, analagous to Git LFS will have a separate get/set mechanism and only object urls and hashes will be kept in the content storage (the repository/vcs).

This setup was decided on to keep a clear separation of concerns and to not duplicate media data in the repo.

There was an implementation where MediaItems were entities in the repo with ids, etc. and note.content.image_id was a reference to that. But when contemplating where MediaItems would be stored in the project folder - it became clear that they duplicate the actual files with content.
One argument for that approach is that in this case we can have proper tracking of media operations in the VCS. Deletes and updates (hash changes, move to different path) are related to the media id. Moving files without that would litter the collaborators' repos with copies.

Previous to that - MediaItems were duplicated in each note as part of the note.content.image, but they still had an id, which was used for reference in the REST api. This was motivated by avoiding the complexity of using relative paths to the files which requires a lot of string safety parsing and can get way ugly in non-ascii languages.

**Current decision (v5):** `FileItem`/`ImageItem` entities have been removed entirely. Image references are stored inline in `note.content.image: { path, width, height, hash }`. The hash is part of the synced note content, so collaborators can detect content changes. Path-based URLs with per-segment encoding handle the REST API routing cleanly.

## File deletion on note-delete
User-actions like note delete should not delete the files referenced by those notes (even on last reference). The reason is that .md files may reference them, and those references are hard to programmatically track. Also the general complexity of that tracking (even for canvas-objects) is not to be underestimated.

Moreover, practically not that many media files accumulate with usage.

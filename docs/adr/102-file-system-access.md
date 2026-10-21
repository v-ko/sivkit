# File system access: names, mechanisms and durable changes

**Status:** accepted (2026-10-21), sivkit 0.13.

SivKit apps keep user data as plain files in folders that other programs also touch: sync tools (Syncthing), editors, backups. Pamet writes its own documents into a project folder. Curator moves and trashes files it doesn't own (anything in Downloads, with any names), never overwrites, and checks size and `mtime_ns` before each operation. Both need the same file operations, and both run them from an asyncio loop.

## What file-based apps have to do

| # | Operation | What goes wrong |
|---|---|---|
| 1 | Replace a file's contents | A crash leaves a torn or empty file (ext4 delayed allocation produced zero-length files for write-close-rename without fsync). Replacing loses permissions, owner, xattrs and hard links, and turns a symlink into a regular file |
| 2 | Create without clobbering | Overwrites a file another program just created |
| 3 | Delete | On Windows, fails while another program has the file open |
| 4 | Rename / move | Multi-file changes aren't atomic. Case-only renames on case-insensitive file systems. Cross-device moves are a copy and a delete |
| 5 | Validate names | Windows reserved names, `<>:"\|?*` and control characters, trailing dot or space, the 255-byte name limit |
| 6 | Name equivalence | Two names are one file on one file system and two on another: case, and Unicode NFC vs NFD |
| 7 | Containment | `..`, symlinks and junctions that lead outside the root |
| 8 | Change detection | Stat fingerprints miss a same-size write within the timestamp granularity ("racy git") |
| 9 | Watching | Events are lost, merged or overflow; a full scan is the fallback |
| 10 | Exclusion between processes | Two instances write the same folder |
| 11 | Outside edits during a save | An outside edit after the last scan is overwritten by the save |
| 12 | Durability | fsync of the file, of the folder, `F_FULLFSYNC` on macOS; an fsync error means the write is lost ("fsyncgate") |
| 13 | Crash leftovers | Temp files stay behind |
| 14 | Transient Windows failures | Antivirus, indexers and sync clients hold files open for short periods |

## Prior art

git, libgit2, SQLite, rsync, Syncthing, Qt and GLib each implement these operations themselves; none share code, and there is no common library for "save a document into a folder". The only reusable pieces are small per-language libraries covering one operation each (`pathvalidate`, `write-file-atomic`, `renameio`, `atomic-write-file`). The mechanisms are short (temp file, fsync, rename: about 20 lines). The projects differ in policy:

| Decision | Choices seen |
|---|---|
| Durability | git: no fsync of refs or index by default. Qt: fdatasync, errors ignored. GLib: folder fsync only at its `DURABLE` level. SQLite and Syncthing: folder too |
| Symlinked target | Qt writes through the link; GLib and `os.replace` replace the link |
| File busy on Windows | git: retries ~70 ms, then asks the user. SQLite: retries 10 times. Qt and Python: fail |
| Case and Unicode | git: probes the file system once at init. Syncthing: checks the real listing, converts names to NFC. Qt: fixed per OS (wrong for some volumes, QTBUG-28246) |
| File changed since last read | GIO: etag (`G_IO_ERROR_WRONG_ETAG`). Syncthing: refuses and rescans (`errModified`). git, rsync, Qt, GLib: overwrite |
| Names | git: `core.protectNTFS` on every platform by default. Syncthing: Windows rules on Windows only |

Case behaviour can't be predicted per OS or even per volume (case-sensitive folders on Windows, case-insensitive ones on ext4), so projects that get it right look at the actual files.

## Decision

Three layers. Only the first exists in both languages, because no SivKit TS code touches the file system; clients use it to refuse a bad name before they commit a change the server would reject.

| Layer | Python | TypeScript | Policy |
|---|---|---|---|
| **0. Names** (pure) | `check_portable_name`, `check_portable_path`, `canonical_key` | twins, with a parity run over every code point and shared inputs (as `tests/hash-parity/`) | the rule set itself |
| **1. Mechanisms** (sync functions) | `resolve_in_root`, `check_new_path`, `atomic_replace`, `create_new`, `move`, `delete`, `make_folder`, `fingerprint`; `scan` later | – | none: every choice is an explicit argument (`durable=`, `expect=`, …) |
| **2. Changes** (async, opinionated) | `apply(root, change)` with `Create`, `Replace`, `Rename`, `Delete`; `scan`, `read` later | – | fixes Layer 1's arguments to the policy below |

Layer 1 serves migrations, scripts and tests directly, and apps that need a different policy. Its `durable=` argument follows GLib's explicit `CONSISTENT`/`DURABLE` levels (`g_file_set_contents_full`). Configurability later means a `policy` argument for `apply` whose fields are Layer 1's existing arguments; there is no policy object until a second value exists.

### Why async, and at which granularity

Python has no async I/O for regular files; aiofiles and anyio run every call in a worker thread. So async here only keeps the event loop free. One `await` per change (one worker trip for its checks, its write and its fsyncs) costs nothing over today's `to_thread`, while one `await` per system call (anyio) would cost a trip per call and add a dependency. Apps run independent changes concurrently with `asyncio.gather`, so their fsyncs overlap without a thread pool of SivKit's own. Worker work can't be cancelled, so a change always runs to the end; a cancelled caller returns early. SivKit keeps no queue or lock: the app orders dependent changes and serializes its own saves.

### Policy

| # | Decision | Choice and reason | Follows |
|---|---|---|---|
| 1 | Which names are checked | Only names a change introduces: a created file, created folders, and the parts a rename changes. Existing names are never policed: replacing, moving or deleting an oddly named file is always allowed | git refuses bad paths when it would create them (`core.protectNTFS`, `verify_path`), not when they already exist; Curator moves files with any names |
| 2 | Rule set | Windows, macOS and Linux rules on every OS; refuse, never fix up. Projects sync across OSes | git: `core.protectNTFS` on by default on every platform (`environment.c`). Rules: Syncthing `WindowsInvalidFilename` (`lib/fs/util.go`), pathvalidate's universal platform |
| 3 | NFC | Clients normalize what the user types; the server refuses non-NFC names. A silent rewrite on the server would make the store and the disk disagree. Existing NFD files load as they are | NFC as the canonical form: git `precompose_utf8.c`, Syncthing's scanner. Not followed: Syncthing's `AutoNormalize` renaming files on disk |
| 4 | Collisions | Introduced names are compared with their siblings on disk, when the change runs, by `canonical_key`: NFC, lower case, upper case, lower case, NFC. It is the same in Python and TS, folds `ς`/`σ` like NTFS and APFS, and also `ß`/`ẞ`/`ss`, a harmless extra refusal. This forbids `Notes` beside `notes` even on Linux. A change sees the changes that finished before it | Syncthing `lib/fs/casefs.go` compares with the real listing. Not followed: Qt's per-OS `isCaseSensitive` (QTBUG-28246) |
| 5 | Compare before replace | Layer 1's replace, move and delete carry `expect`: a fingerprint, `ABSENT` or `ANY`. A mismatch returns `Conflict` with the current fingerprint and doesn't touch the file. SivKit only reports; the app decides what a conflict means. `apply`'s changes don't carry `expect` until an app needs it there | Syncthing `errModified` (`lib/model/folder_sendrecv.go`), GIO `G_IO_ERROR_WRONG_ETAG` (`glocalfileoutputstream.c`). Fingerprint fields: git `statinfo.c` |
| 6 | Never overwrite on create and move | Published with a hard link (POSIX) or `rename` (Windows), which fail if the target exists. Where hard links aren't supported: check, then rename, with a small window accepted for single-user apps. Files only | git `finalize_object_file` (`object-file.c`): `link`, and on FAT or Coda `stat` then `rename` |
| 7 | Durability | fsync each file before it is published, then its folder (skipped on Windows). A move or rename between folders makes the new name durable before it unlinks the source; a new folder's parent is fsynced when it's created. Without the folder fsync a new file can vanish after a power loss, the most common bug in Pillai et al. No `F_FULLFSYNC`. An fsync error fails the change, and the temp file is never fsynced again. A folder fsync that the file system doesn't support (`EINVAL`, `ENOTSUP` on some network and FUSE file systems) is skipped. Apps that don't need durability call Layer 1 with `durable=False` | SQLite `UNIXFILE_DIRSYNC` (including the skipped unsupported folder fsync), GLib `DURABLE`, Syncthing `fsyncDirs`; Ric Wheeler in LWN 322823 for cross-folder renames; fsyncgate (Dan Luu). `F_FULLFSYNC` off as in SQLite's default |
| 8 | Symlinks | The root may be a symlink; parts below it may not be symlinks or Windows junctions, for writes. `scan` doesn't follow them and lists them as skipped | git `has_symlink_leading_path` (`symlinks.c`), used by `apply` and `dir.c` |
| 9 | Temp files | `.<name>.<16 hex>.tmp` next to the target (a hash replaces a name too long for the limit). The dot hides them on Linux and macOS, but sync tools such as Syncthing still see them. Leftovers from a crash stay: SivKit never deletes files by pattern in a folder it doesn't own, and apps skip them with their own ignore rules | rsync `.<name>.XXXXXX`, Syncthing `.syncthing.<name>.tmp` with hashed long names (`lib/fs/tempname.go`). Not followed: Syncthing's age-based cleanup (`KeepTemporariesH`) |
| 10 | Busy files on Windows | No retry. A later Layer 1 argument (git's ~70 ms schedule) if users report it | Qt and Python fail. git `mingw_rename` and SQLite `winIoerrCanRetry1` retry |
| 11 | Locks between processes | None. Apps run one instance per config folder; lock files don't work across synced devices | `QLockFile` is the candidate if this changes |
| 12 | Changes | One change per `apply` call, with its own result. A refusal (`UnsafeName`, `UnsafePath`, `Conflict`) means nothing changed; an `OSError` means the change's paths are in an unknown state and the app re-reads them; no error means done. No batches, no undo, no rollback. A rename publishes the new name before it removes the old one | Syncthing fails single items and lets the next scan settle the rest |
| 13 | Cross-device move | Copy, fsync, check that the source's fingerprint didn't change during the copy, publish, fsync the target folder, then unlink the source | Curator's move design; Wheeler's ordering advice |
| 14 | Trash | Not in SivKit: it needs Qt (`QFile.moveToTrash`) or another dependency. The app trashes | – |
| 15 | Metadata on replace | The mode is copied to the temp file before its fsync; owner, xattrs and hard links aren't kept, and a symlinked file becomes a regular file. A rename with new content writes a new file, which gets default permissions; a plain `move` keeps everything | `QSaveFile::commit` sets permissions before the sync; Syncthing `AtomicWriter` restores the mode. A replaced link as in GLib and `os.replace`; not Qt's write-through |
| 16 | Folders | Writes need an existing parent folder. Apps create folders with `make_folder`, one level at a time; an existing folder counts as done | `pathlib`'s `mkdir(parents=False)`. Not followed: git creating leading folders for every write |
| 17 | Hung calls | No timeouts. A worker thread, or a process inside a kernel call, can't be killed. An app may stop waiting (`asyncio.timeout`), but the call keeps running, so the app keeps its own ordering until it returns | – |

Tested on Linux only. Unverified: case-only renames on case-folding file systems, the no-clobber `rename` on Windows (6) and the junction check (8).

Left to the apps: what a conflict means (Pamet: whose version wins; Curator: a blocked operation), what to do about a change that failed (retry, revert, reload), the order of dependent changes, creating folders, reporting a slow disk, their file formats and ignore rules, Curator's locations and trash.

### Rejected

- **A library per operation** (`pathvalidate`, `atomicwrites`, `QSaveFile`): each covers one row, none exists in both languages, and `QSaveFile` ignores fsync errors.
- **anyio**: see "Why async".
- **Batches with stages** (one fsync round for all temps, one per touched folder): fewer folder fsyncs, but they need batch rules or a fixed order inside the batch so that each change's checks stay valid. Concurrent single changes give the same rounds for the common save of edits only.
- **Cleaning temp files when a root opens**: it deletes files by pattern in a folder other programs use, to remove leftovers that only crashes leave.
- **Predicting case sensitivity per OS**: wrong for some volumes; actual files are compared instead.

## References

- T. S. Pillai et al., "All File Systems Are Not Created Equal: On the Complexity of Crafting Crash-Consistent Applications", OSDI 2014.
- Dan Luu, "Files are hard" (danluu.com/file-consistency) and "Files are fraught with peril" (danluu.com/deconstruct-files).
- SQLite, "Atomic Commit In SQLite" and "How To Corrupt An SQLite Database File".
- J. Corbet, "ext4 and data loss", LWN 322823; V. Aurora, "POSIX v. reality: A position on O_PONIES", LWN 351422.
- Source read: git (`lockfile.c`, `compat/mingw.c`, `statinfo.c`), Syncthing (`lib/fs`, `lib/osutil/atomic.go`), SQLite (`os_unix.c`, `os_win.c`), Qt (`qsavefile.cpp`, `qlockfile.cpp`), GLib (`gfileutils.c`, `glocalfileoutputstream.c`), rsync.

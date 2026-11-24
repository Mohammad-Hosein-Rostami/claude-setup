# project-notes (shared)

Notes per project that everyone who uses this setup gets: one file each, `<key>.md`, where the key is the project's remote
repository name, else its folder name. A note says how the global setup combines with that project's own setup (its
commands, conventions and facts); the project's own committed files never mention these notes and are never edited for them.

Shared notes live here, in the core repo. Personal ones live in `personal/project-notes/` (git-ignored, its own repo, made by
`scripts/install.sh`), which `~/.claude/project-notes` links to; the first install of that layer moves each note here that git does not track (and
each one a pull just deleted) into that folder; later installs leave a new note here for you to commit. The project-merge start hook reads both folders (it finds this one from its own real path).

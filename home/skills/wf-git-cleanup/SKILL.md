---
name: wf-git-cleanup
description: Clean leftover branches, copies (-2, -3), merged worktrees and tangled history in one or more repos through the git-cleanup workflow - Sonnet plan with patch-id proof, apply only proven items.
when_to_use: The owner asks to clean git, or git-tidy reports findings in a repo. One repo or several.
argument-hint: <repo folders>
---

Call Workflow with `scriptPath` `${CLAUDE_SKILL_DIR}/../../workflows/git-cleanup.js` and `args` `{row, repos}`
(`repos` an array of absolute repo folders; `row` the STATUS.md row).
It removes only what `git-tidy prune` proves merged and the plan clears, after a backup bundle in each repo's `.git/`.
It never touches dirty worktrees, unique commits or published merges: they return in `ownerItems`. Ask the owner each item
(`ask-owner`), land what `NEEDS LANDING` says, then run it again.
`scriptsDir` (`${CLAUDE_SKILL_DIR}/../../workflows`) is not needed: this script starts no other workflow.
If Workflow refuses the path, Read the file and pass its text as `script` with the same `args`.

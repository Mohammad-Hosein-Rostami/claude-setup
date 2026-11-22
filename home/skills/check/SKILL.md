---
name: check
description: "Turn check categories on or off for this session (owner only): test, types, review, ui, probe or all, optionally `for <scope>`; `off [<categories>]` turns them off, `default` resets; no argument shows the state. Defaults in home/checks/categories.json (off)."
disable-model-invocation: true
argument-hint: test|types|review|ui|probe|all [for <scope>] | off [<categories>] | default
---

The checks-switch hook already recorded `$ARGUMENTS` for this session and printed the result above (a line starting
"Checks"). Reply in 2 lines or fewer: relay that line, and for categories turned on name the gates that now run:
`test` (targeted tests, suite, pre-commit tests, test-first, test-writer), `types` (typecheck gate, lint, build),
`review` (review-tier set, verdict.mjs rounds, audits, critic), `ui` (ui-check, visual-qa, ui-quality-pass, ui-proof gate),
`probe` (live probes, replay, `doctor --live`). Then continue any pending task with those checks; every category that is off
is named in the final reply under "not checked:".

If no "Checks" line came from the hook, say the switch did not change (the hook did not run) and change nothing yourself:
only this command, typed by the owner, changes a category.

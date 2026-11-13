# Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `doctor.sh`: `link X` FAIL | `~/.claude/X` is not the repo symlink. Run `scripts/install.sh`; the old item is in `~/.claude-backup-<stamp>/`. |
| `doctor.sh`: settings differ | Live edits (`/config`). Copy wanted keys into `settings/*.json`, re-run the installer. |
| A change does not show in a session | The session started before it. Restart it (`/exit`, `claude -c`); after a `settings/` change re-run the installer first. |
| A hook never fires | Test it as Claude runs it: `echo '{"hook_event_name":"UserPromptSubmit","cwd":"/tmp","prompt":"fix the button layout"}' \| node ~/.claude/hooks/skill-router.mjs`. No output means the script did not run `main()`: the entry check must compare `realpathSync(process.argv[1])`, because `~/.claude/hooks` is a symlink and `import.meta.url` is the resolved path. |
| skill-router names skills for a non-UI prompt | A keyword is too broad. Narrow it in `PROMPT_ROUTES` and check with `skillsForPrompt()`. |
| Windows: items copied, edits do not follow | Symlinks need Developer Mode. Enable it and re-run `install.ps1`. |
| Plugin install skipped | `claude plugin` subcommands missing. Use `/plugin` and the list in `plugins/plugins.json`. |
| Commit rejected, gitleaks | A staged change looks like a secret. Remove it; do not bypass the hook. |
| Commit blocked: gitleaks not installed | `brew bundle --file tools/Brewfile` (or the Windows script). |
| `ui-check` exit 2: `Playwright not found from ...` | Pass `--project <dir with @playwright/test>`. |
| `ui-check` exit 2: `cannot launch Chromium` | `npx playwright install chromium` in that project (the tool never downloads browsers). |
| `ui-check` exit 2: `odiff-bin is not installed` | `scripts/install.sh` (or `pnpm install` / `npm install` in `home/tools/ui-check`). |
| `ui-check` exit 2: `FIGMA_TOKEN is not set` | See `docs/setup.md`, or fill the cache with the MCP fallback. |
| `figma-pull` 403/404 | Token lacks access to the file, or the node id is wrong (`12:34`, colon not dash, in the command). |
| `compare` size mismatch | Page root is not the frame size. Fix the root element's size first; padding is applied only so the diff still runs. |
| `compare` diff high, element table empty | Wrong root, different content, or a font fallback. Check `actual.png` once; set up the same state as the frame. |
| `compare` differs between runs | Page animates or loads late data. Mock the data; the tool already freezes animations and waits for fonts and images. |
| `line-height: normal` row | Set an explicit line-height equal to the Figma value. |
| `responsive` reports a tap target you cannot change | Inline links in text are exempt (the tool skips `display: inline`); otherwise grow the hit area with padding. |
| Hook blocks a Bash command | `pre-bash-guard.mjs` denies `--no-verify`, force push, `rm -rf` outside the project, editing lockfiles and literal secrets in the command. Run the safe equivalent. A confirm prompt (push, publish, gh release, prod host writes) is not a block: answer it. |

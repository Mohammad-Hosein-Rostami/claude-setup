# Troubleshooting

| Symptom | Cause and fix |
| ------- | ------------- |
| `~/.claude/X` is not the repo's link | `~/.claude/X` is not the repo symlink. Run `scripts/install.sh`; the old item is in `~/.claude-backup-<stamp>/`. |
| `disk-free.mjs check` prints `FAIL  disk free ...` (or a landing refused with it) | Less than 5 GB free (`DISK_FAIL_FREE_GB`; `WARN` below 15 GB, `DISK_WARN_FREE_GB`). Clear the caches the line names, biggest first (Xcode DerivedData, CoreSimulator, `~/Library/Caches`, npm/pnpm stores, `docker builder prune`, old `/private/tmp/claude-<uid>` session folders), then re-run. |
| `~/.claude/settings.json` differs from `settings/*.json` | Live edits (`/config`). Copy wanted keys into `settings/*.json`, re-run the installer. |
| A change does not show in a session | The session started before it. Restart it (`/exit`, `claude -c`); after a `settings/` change re-run the installer first. |
| A hook never fires | Test it as Claude runs it: pipe the event JSON Claude sends into the script (`echo '<event json>' \| node ~/.claude/hooks/<name>.mjs`). A hook that should print and prints nothing did not run `main()`: the entry check must compare `realpathSync(process.argv[1])`, because `~/.claude/hooks` is a symlink and `import.meta.url` is the resolved path. |
| Sessions ended when the editor window closed or reloaded | They ran in the editor's built-in terminal, which stops with the window. Run long or unattended sessions in a plain terminal app or tmux; resume with `claude --model <m> --effort <e> -c`. |
| Windows: items copied, edits do not follow | Symlinks need Developer Mode. Enable it and re-run `install.ps1`. |
| Plugin install skipped | `claude plugin` subcommands missing. Use `/plugin` and install the plugins the install output names (the ones `enabledPlugins` turns on). |
| `gitleaks git --staged` reports a leak | A staged change looks like a secret. Remove it from the change before you commit; never commit it. |
| `gitleaks` is not installed | `brew bundle --file tools/Brewfile` (or the Windows script). |
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
| A prompt from Claude Code although agents have full access | This setup adds no prompt to a command. Claude Code's own checks still ask in every mode for a few actions, for example `rm` or `rmdir` on a critical path; answer it in the terminal. |

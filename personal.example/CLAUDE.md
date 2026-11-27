# Personal rules (yours, never shared)

<!-- ~/.claude/CLAUDE.md imports this file after the shared core rules (home/CLAUDE.md), so it loads in every session.
     scripts/install.sh copied it from personal.example/; this folder is git-ignored by the core repo and is its own git repo:
     commit your changes here. Put here what is true for you only: who you are, the language to reply in, your machines,
     your plan and billing facts, your own standing rules and lines for the main session only. Same topic as a core rule:
     the stricter one applies. -->

## Who and where

- Reply in <your language>, also after a compaction.
- Machines and shells: <each machine you use and its shell, e.g. a laptop on macOS (zsh), a desktop on Windows (PowerShell)>.
- Accounts and billing limits: <your plan and accounts, and what no session may spend, e.g. never use usage credits>.

## Main session only (the boss)

- Sync targets: the machines `scripts/sync-machines.mjs` brings along live in `settings/local.json` under
  `claudeSetup.syncTargets` (`[{name, ssh}]`); <list yours there, not here>.
- After an install or sync that changes the shell start-up files, tell me to restart each Claude Code session from a new
  terminal on every machine: a running session keeps the environment it started with.
- Landings: <how you want landings reported, e.g. only landings, decisions and problems>.

# plugins

`plugins.json` lists the plugins this setup knows, which of them are on, and the marketplaces they come from. This page says why
each plugin is on, off, or on per project. The ids are `<plugin>@<marketplace>`.

## On

`frontend-design@anthropic-plugin-directory`, `typescript-lsp@claude-plugins-official` and `figma@claude-plugins-official`
are on in every session. No reason beyond that is recorded.

## Off everywhere, on per project

`superdesign@anthropic-plugin-directory` and `miro@claude-plugins-official` are off in every session to keep the skill list
short. A project that needs one turns it on in its own `.claude/settings.local.json`, under `enabledPlugins`.

## Off, with a reason

- `playwright@anthropic-plugin-directory` and `chrome-devtools-mcp@claude-plugins-official`: their browser tool lists cost every
  session and agent tokens. `dev-ui`, `dev-pixel` and `pixel-qa` start the same two servers, with the same commands, as inline
  `mcpServers` of their own.
- `gitkraken-hooks@gitkraken`: its hooks add about 45 ms to every tool call. The GitKraken app works without it.
- `superpowers@anthropic-plugin-directory`: its "1% chance" skill rule fights the routing rules, and it costs about 2k tokens
  per turn.
- `github@anthropic-plugin-directory`: its MCP server fails every start with 400. Use the `gh` CLI.
- `kotlin-lsp@claude-plugins-official`, `code-modernization@anthropic-plugin-directory`, `swift-lsp@claude-plugins-official`
  and `clangd-lsp@claude-plugins-official`: no reason is recorded.
- Turned off by the owner on 2026-11-18 (`context7@anthropic-plugin-directory` on 2026-11-19, with its sign-in declined):
  `code-review-anthropics@anthropic-plugin-directory`, `skill-creator@anthropic-plugin-directory`,
  `code-simplifier@anthropic-plugin-directory`, `claude-md-management@anthropic-plugin-directory`,
  `claude-code-setup@anthropic-plugin-directory` and `context7@anthropic-plugin-directory`.

## Marketplaces

`anthropic-plugin-directory`, `claude-plugins-official` and `gitkraken`. `plugins.json` says where each one comes from.

## What the installer does with plugins

- It installs only the plugins that the merged settings turn on: `settings/base.json`, then `<os>.json`, then `local.json`, and a
  later file wins.
- It never uninstalls a plugin. A plugin installed earlier and now off stays installed and off.
- A project that turns on a plugin left off here needs `claude plugin install <id>` once.

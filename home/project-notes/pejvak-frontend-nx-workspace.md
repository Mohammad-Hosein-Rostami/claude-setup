# pejvak-frontend-nx-workspace: personal layer

Team setup (AGENTS.md, CLAUDE.md, `.claude/`) wins on conflicts; its agents shadow my global ones with the same
name (`architect`, `deep-debugger`, `runner`, `scout`, `implementer`, `ui-implementer`, `reviewer`). My global
skills add on top:

- cp-portal / cp-website / `libs/shared` UI: + `accessibility-build`, `responsive-ui`, `forms-validation`
  (create-product steps and other forms), `async-ui-states` (server data); `ui-quality-pass` before done.
  Figma frame: `figma-pixel-perfect`, then `visual-qa`.
- virtual-menu: project `design-parity` / `responsive-matrix` / `ui-diff-evidence` / `real-verify` win over
  `figma-pixel-perfect`, `responsive-ui` and `visual-qa`.
- The project `ui-implementer` preloads only `ds-*` skills: when delegating, name `accessibility-build`,
  `responsive-ui`, `ui-quality-pass` (+ `forms-validation` / `async-ui-states`) in the prompt.
- `/escalate` and `/quick` still work here (global skills); token cost: `node ~/.claude/hooks/token-audit.mjs`.

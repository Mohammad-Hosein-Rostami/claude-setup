# pejvak-frontend-nx-workspace: personal layer

Team setup (AGENTS.md, CLAUDE.md, `.claude/`) wins on conflicts; its agents shadow my global ones with the same
name (`architect`, `deep-debugger`, `runner`, `scout`, `implementer`, `ui-implementer`). My global
skills add on top:

- cp-portal / cp-website / `libs/shared` UI: + `accessibility-build`, `responsive-ui`, `forms-validation`
  (create-product steps and other forms), `async-ui-states` (server data); `ui-quality-pass` before done.
  Figma frame: `figma-pixel-perfect`, then `visual-qa`.
- virtual-menu: project `design-parity` / `responsive-matrix` / `ui-diff-evidence` / `real-verify` win over
  `figma-pixel-perfect`, `responsive-ui` and `visual-qa`.
- The project `ui-implementer` preloads only `ds-*` skills: when delegating, name `accessibility-build`,
  `responsive-ui`, `ui-quality-pass`, `ui-coverage` (+ `forms-validation` / `async-ui-states`) in the prompt.
- The project `architect` and `ui-implementer` shadow the global ones: a design brief asks for the Reuse inventory,
  Contract facts and Unconfirmed lists and names `STATUS.md` `## Standing rules`.
- `/escalate` and `/quick` still work here (global skills); token cost: `node ~/.claude/hooks/token-audit.mjs`.

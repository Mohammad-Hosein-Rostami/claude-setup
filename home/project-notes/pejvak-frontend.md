# Pejvak_Frontend (SVN): personal layer

Team setup (AGENTS.md, CLAUDE.md, `.claude/`, `.cursor/rules`) wins on conflicts. My global skills add on top:

- Any UI: + `accessibility-build`, `responsive-ui`; `ui-quality-pass` before done (also for screenshot work).
- Forms: `forms-validation` adds UX/a11y checks only; `pejvak-design-system-form-first` decides the stack.
- Dashboard/website data, empty states: + `async-ui-states`. Cards/RTL rows: + `responsive-ui`. DsMenu: +
  `accessibility-build`. Moves/slices: + `safe-refactor`.
- Figma link/node: `figma-pixel-perfect` (keep RTL physical order, rule `00`), then `visual-qa`.
- The project `ui-implementer` preloads only `pejvak-*` skills: when delegating, name `accessibility-build`,
  `responsive-ui`, `ui-quality-pass` (+ `forms-validation` / `async-ui-states`) in the prompt.
- Not git: `CLAUDE.local.md` and `.claude/settings.local.json` must never be `svn add`ed.

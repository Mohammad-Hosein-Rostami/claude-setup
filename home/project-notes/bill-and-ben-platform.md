# bill-and-ben-platform: personal layer

Team setup (CLAUDE.md, `.context/owner-requirements.md`) wins on conflicts. My global skills and agents add on top:

- All UI surfaces in CLAUDE.md (bb-canvas, bb-console, bb-web, bb-design, server-rendered `PAGE_CSS` pages, docs
  theme): `accessibility-build` + `responsive-ui`, `ui-quality-pass` before done. The server-rendered pages and docs
  theme are not `.tsx`, so the skill-router hook will not remind: load the skills by hand.
- bb-canvas live/board data: + `async-ui-states`. bb-console signup/admin/permission forms: + `forms-validation`.
  bb-web: + `frontend-performance`.
- Auth, cookies, CSP, OIDC: `frontend-security`; review with `security-auditor`. Billing periods, schedules,
  history: `datetime-handling`.
- Delegate UI to `ui-implementer`, Figma or multi-width checks to `visual-qa`, non-UI to `implementer`.

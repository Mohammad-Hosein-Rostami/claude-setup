# bill-and-ben-platform: personal layer

Team setup (CLAUDE.md, `.context/owner-requirements.md`) wins on conflicts. My global skills and agents add on top:

- All UI surfaces in CLAUDE.md (bb-canvas, bb-console, bb-web, bb-design, server-rendered `PAGE_CSS` pages, docs
  theme): `accessibility-build` + `responsive-ui`, `ui-quality-pass` before done. The server-rendered pages and docs
  theme are not `.tsx`, so the skill-router hook will not remind: load the skills by hand.
- bb-canvas live/board data: + `async-ui-states`. bb-console signup/admin/permission forms: + `forms-validation`.
  bb-web: + `frontend-performance`.
- Auth, cookies, CSP, OIDC: `frontend-security`. Billing periods, schedules,
  history: `datetime-handling`.
- Delegate UI to `ui-implementer`, Figma or multi-width checks to `visual-qa`, non-UI to `implementer`.

Reviews and tests here (checked 2026-11-22 at main 49c679dd0; re-check a path before relying on it):

- A new HTTP route in any service needs an entry in both route manifests, `services/bb-authz/test/cross-tenant/coverage.yaml`
  and `services/bb-canvas/test/contract/authz-coverage.test.ts`; run both on the branch and on main.
- `node_modules/.bin/vitest` is a pnpm shell shim (node cannot load it): run `node node_modules/vitest/vitest.mjs run <file>`.
  bb-glue runs its test files one at a time (`fileParallelism: false`).
- Erase lists are kept by hand: a new canvas table without a board foreign key goes into `TENANT_KEYED_TABLES`
  (`services/bb-compliance/src/stores/canvas.ts`).
- Judge a branch's failing test against main run the same way: past reviews found failures already on main.

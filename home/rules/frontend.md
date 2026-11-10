---
paths: ["**/*.tsx","**/components/**"]
---
# Frontend rules: id | rule | check
F1 | Function components and hooks; typed props; one component per file | tsc, eslint
F2 | Compose over config props; components <=150 lines | eslint
F3 | Derive, don't sync; effects need cleanup and correct deps | eslint hooks
F4 | Local state first; server state in a query lib | rev
F5 | Stable keys, never index; memoise only after measuring | eslint
F6 | Code-split routes; virtualise >100 rows; LCP<2.5s, INP<200ms | Lighthouse, web-vitals
F7 | Async views handle loading, empty, error, success | rev
F8 | Route error boundary with retry; no raw error text | rev
F9 | Labelled inputs; inline validation; keep input on error | axe
F10 | No any or casts to silence props; discriminated unions | tsc

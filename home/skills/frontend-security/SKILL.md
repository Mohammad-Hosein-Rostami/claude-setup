---
name: frontend-security
description: Use when rendering user content, handling tokens, loading third-party scripts, or touching cookies, CORS or CSP in a web app.
---

Rules: S1-S11 (`~/.claude/standards/security.md`). Sources: MDN, OWASP.

1. Never put untrusted data into `innerHTML`, `dangerouslySetInnerHTML`, `document.write` or `eval`. Use `textContent`/framework escaping; if HTML is required, sanitize with DOMPurify (and Trusted Types where supported). Validate URL schemes (block `javascript:`).
2. CSP: send a strict policy, for example `script-src 'nonce-<random>' 'strict-dynamic'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`, a fresh nonce per response, no `unsafe-inline`/`unsafe-eval`. Roll out with `Content-Security-Policy-Report-Only` first. Also send `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`. Do not rely on `X-Frame-Options` or `X-XSS-Protection`.
3. Session tokens: prefer `HttpOnly; Secure; SameSite=Lax/Strict` cookies over `localStorage`, which any XSS can read. State-changing requests need CSRF protection (token or Origin check); never mutate on GET.
4. CORS: explicit origin allowlist; never `*` with credentials; never reflect the request `Origin`. Third-party scripts: as few as possible, pinned versions, Subresource Integrity (`integrity` + `crossorigin`) on CDN files, loaded `async`/`defer`.
5. `target="_blank"` links carry `rel="noopener noreferrer"`. No secrets in client bundles: every `VITE_*`/`NEXT_PUBLIC_*` value is public.
6. Verify: eslint security rules, grep for `innerHTML`/`localStorage.setItem` of tokens, check response headers, a script that tries `<img onerror>` payloads in every field that renders later.

Done-gate: no unsafe sinks; CSP header present; tokens not in localStorage; payload test clean.

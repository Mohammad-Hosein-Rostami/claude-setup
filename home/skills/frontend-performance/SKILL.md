---
name: frontend-performance
description: Use when a page is slow, heavy or janky, or when adding images, fonts, libraries or routes - Core Web Vitals, bundles, rendering.
---

Targets at the 75th percentile (web.dev): LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1 (F6).

1. Measure first: Lighthouse CI (lab; it has no INP, use TBT as a proxy) and the `web-vitals` library or CrUX (field). For LCP traces use the chrome-devtools browser's performance trace (dev-ui and dev-pixel have it). Record a baseline; change one thing; measure again.
2. LCP: the hero image or text is in the first HTML, preloaded (`fetchpriority="high"`), never lazy-loaded; use AVIF/WebP with `srcset`/`sizes`; serve from a CDN with caching.
3. CLS: width/height or `aspect-ratio` on images, video, embeds and ad slots; reserve space for late content; never insert above existing content; font swap without layout jump (`size-adjust` or `font-display: optional`).
4. INP: keep main-thread tasks under about 50 ms; yield with `scheduler.yield()`; defer non-critical scripts; debounce handlers; move heavy work to a worker; avoid layout thrash; `startTransition` for heavy React updates.
5. Bundles: route-level `import()`, tree-shaking, no whole-library imports (`lodash`), a bundle-size budget checked in CI (size-limit or build analysis). Third-party scripts load `async`/`defer` and are counted.
6. Fonts: self-host WOFF2, subset, preload only the critical ones. Images below the fold use `loading="lazy"`.
7. React/Vue: memoize only after profiling (unless React Compiler is on); stable props for memoized children; virtualize long lists; avoid state high in the tree that re-renders everything.
8. SSR/static helps LCP but adds hydration cost: no time or random values in server output.

Done-gate: before/after numbers for LCP, INP, CLS and bundle size quoted; budget check in CI.

// Purpose: the screens of a frontend project, inferred at a commit from the project itself, with no per-project setup (R22): Next
// `app/` and `pages/`, React Router (`createBrowserRouter` objects, `<Route path>`), Vue Router `routes`, Angular `Routes`,
// ui-coverage matrices (`mountedAt` files, Figma frames), Storybook stories and e2e specs (`page.goto`, `cy.visit`), which also give
// the values of dynamic segments. Exports: NO_VALUE, isComplete, inferScreens.
// A screen: {id, route (null: not a literal path), component, wraps (files rendered around it: layouts, parent routes), urls,
// frames, source}; `wraps` is an addition to the spec's interface (reach walks from it too). `unresolved` lines: a `no value: ` line
// is a screen with no known url (the plan gives it the visual plan); every other line (`unread:`, `capped:`, `unmatched:` (an e2e
// url that fits no route while every route has a value), `incomplete:`) means the list may miss screens: render every inferred route.
// This file picks the files to read, joins e2e urls to routes and keeps the cache; the sources are in screen-sources.mjs (router
// text in route-parse.mjs) and the cache file in screens-cache.mjs.
// Invariants (P1-P3, P8, P16, F3-F5): files are read at the commit with git plumbing (ls-tree, cat-file; `git grep` on the tree finds
// router candidates), nothing is checked out, run or written in the project; reads, lines and counts are capped; project text is
// tokenised, never evaluated. The cache key holds the blob ids of every file read; an incomplete inference is not cached.
import { configFiles, makeResolver } from './resolve.mjs';
import { gitRun, readBlobs, readTree } from './git-read.mjs';
import { MAX_READ_BYTES, MAX_TEXT_CHARS } from './route-parse.mjs';
import { CACHE_FORMAT, cacheFile, hashOf, readCache, stateDirOf, writeCache } from './screens-cache.mjs';
import { E2E_CONFIG, MATRIX, MAX_URLS, NEXT_CONFIG, STORY, e2eEntries, matrixScreens, nextScreens, routerScreens, shellFiles, storyScreen } from './screen-sources.mjs';

export const NO_VALUE = 'no value: ';
const INFER_BUDGET_MS = 30_000;
const MAX_CANDIDATES = 3000;
const MAX_SCREENS = 3000;
const SOURCE_SPECS = ['*.js', '*.jsx', '*.ts', '*.tsx', '*.mjs', '*.cjs', '*.mts', '*.cts', '*.vue', ':(exclude)*.d.ts'];
// Fixed strings (`git grep -F`): with -E the search time grows with the word count and passes git's 5 s timeout on 100k files.
const GREP_WORDS = ['createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'useRoutes', '<Route', 'Routes', 'createRouter',
  'VueRouter', 'RouterModule', 'provideRouter', 'page.goto', 'cy.visit',
  // the app shell around every route: render entries and router outlets (shellFiles)
  'createRoot', 'hydrateRoot', 'ReactDOM.render', 'createApp', 'createSSRApp', 'bootstrapApplication', 'bootstrapModule', 'router-view',
  'RouterView', 'router-outlet', 'RouterOutlet', 'RouterProvider'];

const quote = (text) => JSON.stringify(String(text).slice(0, MAX_TEXT_CHARS));

/** A route -> {regex, statics, dynamic}: `:id`, `[id]` one segment; `:id?` optional; `*`, `**`, `[...x]`, `:x(.*)*` any rest. */
function routePattern(route) {
  let source = '';
  let statics = 0;
  const segments = route.split('/').filter(Boolean);
  for (const segment of segments) {
    if (/^(?:\*\*?|\[\[?\.\.\..*\]\]?|:[\w$]+(?:\(.*\))?[*+])$/.test(segment)) source += '(?:/.*)?';
    else if (/^:[\w$]+\?$/.test(segment)) source += '(?:/[^/]+)?';
    else if (/^:[\w$]+(?:\(.*\))?$|^\[[^\]]+\]$/.test(segment)) source += '/[^/]+';
    else { source += `/${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`; statics += 1; }
  }
  return { regex: new RegExp(`^${source}/?$`), statics, dynamic: statics !== segments.length };
}

/** The route screens with their urls (static path, e2e values), plus e2e-only screens and the `no value` lines. */
function withUrls(routes, e2e) {
  const patterns = routes.map((s) => (s.route === null ? null : routePattern(s.route)));
  const urls = routes.map((s, i) => new Set(patterns[i] && !patterns[i].dynamic ? [s.route] : []));
  const unmatched = new Map();
  for (const { url, spec } of e2e) {
    const pathname = url.split(/[?#]/)[0];
    const fits = patterns.map((p, i) => (p && !(p.statics === 0 && p.dynamic) && p.regex.test(pathname) ? i : -1)).filter((i) => i >= 0);
    const best = Math.max(-1, ...fits.map((i) => patterns[i].statics));
    if (fits.length > 0) for (const i of fits.filter((j) => patterns[j].statics === best)) urls[i].add(url);
    else unmatched.set(pathname, { spec: unmatched.get(pathname)?.spec ?? spec, urls: new Set([...(unmatched.get(pathname)?.urls ?? []), url]) });
  }
  const screens = routes.map((s, i) => ({ id: `${s.source}:${s.route ?? s.component}`, route: s.route, router: s.router ?? null, component: s.component, wraps: s.wraps, urls: [...urls[i]].slice(0, MAX_URLS), frames: [], source: s.source }));
  const noValue = routes.flatMap((s, i) => (urls[i].size > 0 ? [] : [`${NO_VALUE}${s.route === null ? s.expr : quote(s.route)} (${s.component}, ${s.where})`]));
  const e2eScreens = [...unmatched].map(([pathname, entry]) => ({ id: `e2e:${pathname}`, route: pathname, router: null, component: entry.spec, wraps: [], urls: [...entry.urls].slice(0, MAX_URLS), frames: [], source: 'e2e' }));
  const missed = noValue.length === 0 ? [...unmatched.keys()].map((p) => `unmatched: the e2e url ${quote(p)} fits no inferred route`) : [];
  return { screens: [...screens, ...e2eScreens], unresolved: [...noValue, ...missed] };
}

/** Unique ids; Figma frames of a matrix surface also on the route screens whose component it mounts; capped count. */
function finish(screens, unresolved) {
  const seen = new Map();
  for (const screen of screens) {
    const n = seen.get(screen.id) ?? 0;
    seen.set(screen.id, n + 1);
    if (n > 0) screen.id = `${screen.id} #${n + 1}`;
  }
  for (const surface of screens.filter((s) => s.source === 'matrix')) {
    const files = new Set([surface.component, ...surface.wraps]);
    for (const screen of screens.filter((s) => s.source !== 'matrix' && files.has(s.component))) screen.frames = [...new Set([...screen.frames, ...surface.frames])];
  }
  const capped = screens.length > MAX_SCREENS ? [`capped: ${screens.length} screens, the first ${MAX_SCREENS} kept`] : [];
  return { screens: screens.slice(0, MAX_SCREENS).sort((a, b) => (a.id < b.id ? -1 : 1)), unresolved: [...unresolved, ...capped] };
}

/** The files the inference reads at a commit (router candidates found by `git grep` on the tree, stories, matrices, configs). */
function inputFiles(repoDir, sha, tree) {
  const problems = [];
  let hits = [];
  try {
    const args = ['-c', 'grep.fallbackToNoIndex=false', 'grep', '-l', '-z', '-I', '-F', '--no-color', ...GREP_WORDS.flatMap((w) => ['-e', w]), sha, '--', ...SOURCE_SPECS];
    hits = gitRun(repoDir, args, undefined, [0, 1]).toString('utf8').split('\0').filter(Boolean).map((entry) => entry.slice(sha.length + 1));
  } catch (error) {
    problems.push(`unread: the router search failed: ${error.message}`);
  }
  const all = [...tree.keys()];
  const cap = (list, what) => { if (list.length > MAX_CANDIDATES) problems.push(`capped: ${list.length} ${what}, the first ${MAX_CANDIDATES} read`); return list.slice(0, MAX_CANDIDATES); };
  const big = (f) => tree.get(f).size > MAX_READ_BYTES;
  const pick = (list) => { problems.push(...list.filter(big).map((f) => `unread: ${f} is over ${MAX_READ_BYTES} bytes`)); return list.filter((f) => !big(f)); };
  const candidates = pick(cap(hits.filter((f) => tree.has(f)), 'router and e2e files'));
  const stories = pick(cap(all.filter((f) => STORY.test(f)), 'story files'));
  const matrices = pick(cap(all.filter((f) => MATRIX.test(f)), 'matrix files'));
  const configs = pick([...configFiles(tree), ...all.filter((f) => E2E_CONFIG.test(f))]);
  const listed = all.filter((f) => NEXT_CONFIG.test(f) || /(?:^|\/)(?:app|pages)\/.+\.(?:[jt]sx?|mdx)$/.test(f));
  return { candidates, stories, matrices, read: [...new Set([...candidates, ...stories, ...matrices, ...configs])], listed, problems };
}

/** Router screens with the app shell (files rendered around every route) added to their wraps. */
function withShell(router, candidates, texts) {
  const routeFiles = new Set(router.screens.flatMap((s) => [s.component, ...s.wraps]));
  const shells = shellFiles({ candidates, texts, rootFiles: router.rootFiles, routeFiles });
  return router.screens.map((s) => ({ ...s, wraps: [...new Set([...s.wraps, ...shells.filter((f) => f !== s.component)])] }));
}

/**
 * Infer from the read inputs; the time budget is checked before each source and at each router file, and a spent budget gives one
 * `incomplete:` line (so the result is not cached). @returns {{screens: object[], unresolved: string[], extra: Record<string,string>}}
 */
function inferAt({ repoDir, tree, inputs, deadline, budgetMs }) {
  const late = () => Date.now() > deadline;
  const blobs = readBlobs(repoDir, inputs.read.map((f) => tree.get(f).blob));
  const texts = new Map(inputs.read.map((f) => [f, blobs.get(tree.get(f).blob) ?? '']));
  const resolve = makeResolver(tree, new Map(configFiles(tree).map((f) => [f, texts.get(f) ?? ''])));
  const extra = {};
  const readMore = (file) => {
    const entry = tree.get(file);
    if (!entry || entry.size > MAX_READ_BYTES || !/\.(?:[cm]?[jt]sx?|vue)$/.test(file)) return null;
    extra[file] = entry.blob;
    return readBlobs(repoDir, [entry.blob]).get(entry.blob) ?? null;
  };
  const none = { screens: [], rootFiles: [], problems: [] };
  const router = late() ? none : routerScreens({ candidates: inputs.candidates, texts, resolve, readMore, late });
  const routes = [...(late() ? [] : nextScreens(tree, texts)), ...withShell(router, inputs.candidates, texts)];
  const e2e = late() ? [] : e2eEntries(inputs.candidates.filter((f) => /\b(?:page\.goto|cy\.visit)\s*\(/.test(texts.get(f))), texts);
  const routed = withUrls(routes, e2e);
  const others = late() ? [] : [...inputs.stories.map((f) => storyScreen(f, texts.get(f))), ...inputs.matrices.flatMap((f) => matrixScreens(f, texts.get(f), tree))];
  const over = late() ? [`incomplete: the inference passed its ${budgetMs / 1000} s budget`] : [];
  const { screens, unresolved } = finish([...routed.screens, ...others], [...inputs.problems, ...router.problems, ...routed.unresolved, ...over]);
  return { screens, unresolved, extra };
}

/** True when the screen list is complete: every unresolved line is a `no value` line (else render every inferred route). */
export const isComplete = (unresolved) => unresolved.every((line) => line.startsWith(NO_VALUE));

/**
 * The screens of the project at `rev`, from the cache when no file it read has changed.
 * @param {{repoDir: string, rev: string, stateDir?: string, budgetMs?: number}} input stateDir default: UI_SCREENS_STATE_DIR or
 *   ~/.claude/state/ui-screens; budgetMs: the time budget of one inference (default 30 s; over it the result is incomplete)
 * @returns {{screens: {id: string, route: string|null, router: string|null, component: string, wraps: string[], urls: string[],
 *   frames: string[], source: 'next'|'react-router'|'vue-router'|'angular'|'matrix'|'story'|'e2e'}[], unresolved: string[],
 *   cached: boolean}} `router`: the file that declares a router screen (null for the other sources); never throws: an
 *   unreadable repo or rev gives no screens and one `unread:` line
 */
export function inferScreens({ repoDir, rev, stateDir = stateDirOf(process.env), budgetMs = INFER_BUDGET_MS }) {
  const deadline = Date.now() + budgetMs;
  try {
    if (typeof rev !== 'string' || rev === '' || rev.startsWith('-')) throw new Error(`bad rev ${quote(rev)}`);
    const sha = gitRun(repoDir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]).toString('utf8').trim();
    const tree = readTree(repoDir, sha);
    const inputs = inputFiles(repoDir, sha, tree);
    const key = hashOf([CACHE_FORMAT, ...inputs.listed, ...inputs.read.map((f) => `${f}\0${tree.get(f).blob}`), ...inputs.problems]);
    const store = cacheFile(repoDir, stateDir);
    const hit = readCache(store).find((e) => e.key === key && Object.entries(e.extra).every(([f, blob]) => tree.get(f)?.blob === blob));
    if (hit) return { screens: hit.screens, unresolved: hit.unresolved, cached: true };
    const { screens, unresolved, extra } = inferAt({ repoDir, tree, inputs, deadline, budgetMs });
    if (unresolved.some((line) => line.startsWith('incomplete:'))) return { screens, unresolved, cached: false };
    try {
      writeCache(store, { key, extra, screens, unresolved, createdAt: new Date().toISOString() });
    } catch (error) {
      return { screens, unresolved: [...unresolved, `incomplete: the cache was not saved (${error.message})`], cached: false };
    }
    return { screens, unresolved, cached: false };
  } catch (error) {
    return { screens: [], unresolved: [`unread: ${error.message}`], cached: false };
  }
}

// Purpose: the UI check plan (ui-kinds-spec.md sections 2-4, R28): from the request text, the diff and the screens the diff reaches,
// how closely a change must be checked: none < same < render < visual < pixel, per reached surface, with one reason line per safe path.
// Exports: planChecks, briefFloor, and (from ui-plan-proof.mjs) planProofProblem and runFiles. The rules in words:
// home/standards/ui-checks.md.
// Invariants (P3, P14): unknown or failed evidence plans the full checks (pixel), never less; a surface's needs are a set, and request
// text (design words, a no-change request) and the `UI-PLAN:` floor only add to it: `same` (the identical-render proof) stays beside
// any raised need; a renamed file counts as a delete and an add (`--no-renames`), so it is always a change; a change users see never
// plans none: a repository renders when it has a UI file (ui-files.mjs: markup, .astro, .svelte, .vue, .mdx, styles, or a .js with JSX
// or a react, react-native or expo import) or a UI framework dependency; a missing screen map never blocks: reach unresolved renders every inferred
// route, a screen with no url or no base render takes the visual plan, no inferable route at all takes the visual plan. The plan's
// render map (widths, locales, states, the run matrix's sha256) is what a same or render proof must cover. Read-only: git plumbing at
// the given commits, nothing run or written in the project (the screens cache lives under the setup's state).
import fs from 'node:fs';
import path from 'node:path';
import { gitRun, readBlobs, readTree } from './git-read.mjs';
import { TEST_FILE, reachedScreens } from './reach.mjs';
import { matrixScreens } from './screen-sources.mjs';
import { NO_VALUE, inferScreens, isComplete } from './screens.mjs';
import { DEPTHS, classifyFile, requestEvidence, stricterDepth } from './ui-evidence.mjs';
import { isCoreUiPath, isUiPath, isUiRepoAt } from './ui-files.mjs';
import { renderMap } from './ui-plan-proof.mjs';

export { planProofProblem, runFiles } from './ui-plan-proof.mjs';

const EXEMPT_WHY = Object.freeze({ test: 'test file', docs: 'docs page, not served by the app', devConfig: 'dev config: lint, format, type-check, test or CI' });
const NO_LINE_WHY = 'no visible change: lines re-spaced in place or no line changed';
const LOOK_CLASSES = new Set(['look', 'text', 'globalLook']);
const FLOOR_LINE = /^[ \t]*(?:[-*][ \t]+)?UI-PLAN:[ \t]*([^\s]*)/gim;
const MAX_FLOOR_CHARS = 40;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// A dependency key of a UI framework in a package.json (a text match: a broken file still counts).
const UI_FRAMEWORK_DEP = /"(?:react|react-dom|react-native|expo|astro|vue|nuxt|svelte|@sveltejs\/kit|next|preact|solid-js|@angular\/core|lit|gatsby|@remix-run\/react|@builder\.io\/qwik|ember-source)"\s*:/;

/** The floor of every `UI-PLAN: <depth>` line (the strictest valid one) and a reason line per value that is not a depth. */
function floorOf(text) {
  let floor = null;
  const bad = [];
  for (const [, value] of String(text ?? '').matchAll(FLOOR_LINE)) {
    if (DEPTHS.includes(value)) floor = floor === null ? value : stricterDepth(floor, value);
    else bad.push(`UI-PLAN: ${JSON.stringify(value.slice(0, MAX_FLOOR_CHARS))} ignored: not one of ${DEPTHS.join(', ')}`);
  }
  return { floor, bad };
}

/**
 * The brief's floor: the strictest `UI-PLAN: <depth>` line. It can only raise a plan (stricter wins).
 * @param {string|null|undefined} briefText the brief (untrusted text)
 * @returns {string|null} a depth of DEPTHS, or null when no line holds one (a bad value is ignored)
 */
export const briefFloor = (briefText) => floorOf(briefText).floor;

/** Removed and added lines of one file's `-U0` patch, with the hunk of each; null lines for a binary file (judged by path). */
function linesOf(patch) {
  const removed = [];
  const added = [];
  const hunks = { removed: [], added: [] };
  let hunk = -1;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) hunk += 1;
    else if (hunk < 0 && /^(?:Binary files |GIT binary patch)/.test(line)) return { removed: null, added: null, hunks: undefined };
    else if (hunk >= 0 && line.startsWith('-')) { removed.push(line.slice(1)); hunks.removed.push(hunk); }
    else if (hunk >= 0 && line.startsWith('+')) { added.push(line.slice(1)); hunks.added.push(hunk); }
  }
  return { removed, added, hunks };
}

/** Every changed file between two commits with its lines. @throws {Error} when git fails or the patch and the name list disagree */
function diffFiles(repoDir, base, tip) {
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', base, tip, '--'];
  const names = gitRun(repoDir, ['diff', '--name-only', '-z', ...common]).toString('utf8').split('\0').filter(Boolean);
  const patch = gitRun(repoDir, ['diff', '-U0', '--src-prefix=a/', '--dst-prefix=b/', ...common]).toString('utf8');
  const patches = patch.split(/^(?=diff --git )/m).filter((part) => part.startsWith('diff --git '));
  if (patches.length !== names.length) throw new Error(`the diff names ${names.length} files but holds ${patches.length} patches`);
  return names.map((file, i) => ({ file, ...linesOf(patches[i]) }));
}

const commitOf = (repoDir, rev) => {
  if (typeof rev !== 'string' || rev === '' || rev.startsWith('-')) throw new Error(`bad commit ${JSON.stringify(String(rev).slice(0, 60))}`);
  const sha = gitRun(repoDir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]).toString('utf8').trim();
  if (!SHA.test(sha)) throw new Error(`git rev-parse gave no full sha for ${rev}`);
  return sha;
};

/** The changes to plan for: the diff base..tip, or (brief time) the expected files judged by path at HEAD. */
function readChanges({ repoDir, base, tip, files }) {
  if (Array.isArray(files)) {
    const head = commitOf(repoDir, 'HEAD');
    return { revs: [head], baseRev: null, tipRev: head, changes: files.map((file) => ({ file: String(file).replace(/\\/g, '/'), removed: null, added: null })) };
  }
  const baseRev = commitOf(repoDir, base);
  const tipRev = commitOf(repoDir, tip);
  return { revs: [baseRev, tipRev], baseRev, tipRev, changes: diffFiles(repoDir, baseRev, tipRev) };
}

/** Split the classified files into exempt ones (tests, docs pages, dev config, nothing visible) and the ones the plan judges. */
function sortFiles(changes) {
  const exempt = [];
  const judged = [];
  for (const change of changes) {
    const classes = classifyFile(change.file, change.removed, change.added, change.hunks);
    if (classes.length === 0) exempt.push({ file: change.file, why: NO_LINE_WHY });
    else if (classes.every((name) => Object.hasOwn(EXEMPT_WHY, name))) exempt.push({ file: change.file, why: EXEMPT_WHY[classes[0]] });
    else judged.push({ file: change.file, classes });
  }
  return { exempt, judged };
}

/** The screens of a lane matrix given by path (outside or inside the repo): read as if it sat at the repo path of its `root`. */
function laneMatrixScreens(repoDir, { matrixPath, matrix }, tree) {
  const top = fs.realpathSync.native(gitRun(repoDir, ['rev-parse', '--show-toplevel']).toString('utf8').trim());
  const rootDir = path.resolve(path.dirname(fs.realpathSync.native(matrixPath)), typeof matrix?.root === 'string' ? matrix.root : '.');
  const relRoot = path.relative(top, rootDir).split(path.sep).join('/') || '.';
  const framed = Array.isArray(matrix?.frames) && matrix.frames.length > 0;
  if (relRoot.startsWith('..') || path.isAbsolute(relRoot)) return { screens: [], framed, matrix };
  return { screens: matrixScreens(`${relRoot}/lane-matrix.json`, JSON.stringify({ ...matrix, root: '.' }), tree), framed, matrix };
}

/** Screens at the tip (lane matrix surfaces added, their frames copied onto route screens of the same files) and the ids at base. */
function screensOf({ repoDir, baseRev, tipRev, laneMatrix }) {
  const tip = inferScreens({ repoDir, rev: tipRev });
  const lane = laneMatrix ? laneMatrixScreens(repoDir, laneMatrix, readTree(repoDir, tipRev)) : { screens: [], framed: false };
  const screens = [...tip.screens.map((s) => ({ ...s })), ...lane.screens];
  for (const surface of lane.screens) {
    const files = new Set([surface.component, ...surface.wraps]);
    for (const screen of screens.filter((s) => s.source !== 'matrix' && files.has(s.component))) screen.frames = [...new Set([...screen.frames, ...surface.frames])];
  }
  const baseIds = baseRev ? new Set(inferScreens({ repoDir, rev: baseRev }).screens.map((s) => s.id)) : null;
  return { screens, unresolved: tip.unresolved, baseIds, laneFramesLoose: lane.framed && lane.screens.length === 0 };
}

/** True when a package.json at the rev (outside test folders) declares a UI framework. */
function declaresUiFramework(repoDir, rev) {
  const tree = readTree(repoDir, rev);
  const packages = [...tree.keys()].filter((file) => /(?:^|\/)package\.json$/.test(file) && !TEST_FILE.test(file));
  return [...readBlobs(repoDir, packages.map((file) => tree.get(file).blob)).values()].some((text) => UI_FRAMEWORK_DEP.test(text));
}

/**
 * True when something in the repository renders, at any of the revs or among the expected files: a change users may see. A UI file
 * is ui-files.mjs's (by path, or a .js whose text has JSX or a react, react-native or expo import), or a UI framework dependency.
 */
const hasUi = (input) => input.changes.some((c) => isCoreUiPath(c.file)) || input.revs.some((rev) => isUiRepoAt(input.repoDir, rev) || declaresUiFramework(input.repoDir, rev));

/** The screens a group of files reaches: id -> the file that reaches it; `all` when reach is unresolved (every screen). */
function reachOf(input, files) {
  if (files.length === 0) return { via: new Map(), why: null };
  const reach = reachedScreens({ repoDir: input.repoDir, revs: input.revs, files, screens: input.screens });
  if (reach.all) return { via: new Map(input.screens.map((s) => [s.id, 'reach unresolved'])), why: reach.why };
  return { via: new Map(reach.reached.map((r) => [r.id, r.via])), why: null };
}

/** Each screen's need from the judged files, before the request's evidence and the floor. */
function screenNeeds(input, judged, reasons) {
  const { screens } = input;
  const named = (name) => judged.filter((f) => f.classes.includes(name)).map((f) => f.file);
  const deps = named('deps');
  const global = named('globalLook');
  const walked = judged.filter((f) => f.classes.some((c) => ['look', 'text', 'logic'].includes(c)) && !f.classes.includes('globalLook'));
  const all = reachOf(input, walked.map((f) => f.file));
  if (all.why) reasons.push(all.why);
  if (!isComplete(input.unresolved)) reasons.push(`screens unresolved: ${input.unresolved.find((l) => !l.startsWith(NO_VALUE))}: rendering every inferred route`);
  const complete = isComplete(input.unresolved);
  const lookFiles = walked.filter((f) => f.classes.some((c) => LOOK_CLASSES.has(c))).map((f) => f.file);
  const framedReached = screens.some((s) => s.frames.length > 0 && all.via.has(s.id));
  const look = lookFiles.length === walked.length || !framedReached ? all : reachOf(input, lookFiles);
  return screens.map((screen) => {
    const via = complete ? all.via.get(screen.id) : all.via.get(screen.id) ?? 'screens unresolved';
    const why = [];
    let need = null;
    if (deps.length > 0) { need = 'same'; why.push(`dependencies changed (${deps[0]})`); }
    if (global.length > 0) { need = 'render'; why.push(`global look in ${global[0]}`); }
    if (via) { need = 'render'; why.push(`${classesVia(walked, via)} via ${via}`); }
    const lookHere = global.length > 0 || (lookFiles.length > 0 && (complete ? look.via.has(screen.id) : true));
    return { screen, need, why, lookHere };
  }).filter((entry) => entry.need !== null);
}

const classesVia = (walked, via) => [...new Set((walked.find((f) => f.file === via)?.classes ?? walked.flatMap((f) => f.classes)))].join('+');

/**
 * A surface's needs with one more need (R1): `same`, the identical-render proof, is kept beside any other need, since a stricter
 * proof (a visual-qa PASS) never proves it; any other need replaces a weaker one (stricter wins). Returned in DEPTHS order.
 */
function addNeed(needs, need) {
  const others = needs.filter((n) => n !== 'same');
  const raised = need === 'same' ? others : [others.reduce((max, n) => stricterDepth(max, n), need)];
  const set = new Set(needs.includes('same') || need === 'same' ? ['same', ...raised] : raised);
  return DEPTHS.filter((depth) => set.has(depth));
}

const strictest = (needs) => needs.reduce((max, n) => stricterDepth(max, n), 'none');

/** The needs of one reached screen once its url, its base render, the request and the Figma frames are weighed (they only add). */
function finalNeeds({ screen, need, why, lookHere }, { evidence, baseIds }) {
  const reasons = [...why];
  let needs = [need];
  if (screen.urls.length === 0) { needs = ['visual']; reasons.push('no url known (a dynamic segment with no value, or no route): visual plan'); }
  else if (baseIds && !baseIds.has(screen.id)) { needs = ['visual']; reasons.push('new screen: no base render, visual plan'); }
  else if (need === 'render' && evidence.noChange) { needs = addNeed(needs, 'same'); reasons.push('no-change request: renders must be identical'); }
  if (evidence.design) { needs = addNeed(needs, 'pixel'); reasons.push('design evidence (see the plan reasons)'); }
  else if (lookHere && screen.frames.length > 0) { needs = addNeed(needs, 'pixel'); reasons.push(`look change on a surface with Figma frame ${screen.frames[0]}`); }
  return { needs, why: reasons };
}

const plan = (depth, { tests = false, surfaces = [], exempt = [], reasons = [] }) => ({ depth, tests, surfaces, exempt, reasons, map: null });
const surfaceOf = (id, needs, why, url) => ({ id, need: strictest(needs), needs, why, url });

/** Add the floor to every surface's needs (a same floor adds the identical-render proof); a same or render floor over no surface renders every screen. */
function withFloor(result, floor, screensAt) {
  if (floor === null) return result;
  const raised = result.surfaces.map((s) => {
    const needs = addNeed(s.needs, floor);
    return needs.join() === s.needs.join() ? s : surfaceOf(s.id, needs, `${s.why}; UI-PLAN floor ${floor}`, s.url);
  });
  if (raised.every((s, i) => s === result.surfaces[i]) && stricterDepth(result.depth, floor) === result.depth) return result;
  const renders = ['same', 'render'].includes(floor);
  const added = raised.length === 0 && renders
    ? screensAt().filter((s) => s.urls.length > 0).map((s) => surfaceOf(s.id, [floor], `UI-PLAN floor ${floor}`, s.urls[0])) : raised;
  const none = added.length === 0 && renders;
  const depth = none ? stricterDepth(result.depth, 'visual') : added.reduce((max, s) => stricterDepth(max, s.need), stricterDepth(result.depth, floor));
  const reasons = [...result.reasons, `UI-PLAN: ${floor} raises the plan${none ? ': no renderable screen, visual plan' : ''}`];
  return { ...result, depth, surfaces: added, reasons };
}

/** The plan once the files are sorted: the request, the repo's UI, the screens and the reach decide each surface's need. */
function planFiles(input, { judged, exempt, evidence, reasons }) {
  const touchesUi = judged.length > 0 || exempt.some((e) => isUiPath(e.file, true) && e.why !== EXEMPT_WHY.test);
  if (!hasUi(input)) {
    const notServed = judged.map((f) => ({ file: f.file, why: 'nothing in the repository renders' }));
    return plan('none', { exempt: [...exempt, ...notServed], reasons: [...reasons, 'nothing in the repository renders at the planned commits (no UI file, no .astro, .svelte, .vue or .mdx file, no UI framework dependency, no .js with JSX or a UI import): plan none'] });
  }
  if (evidence.design && touchesUi && judged.length === 0) return plan('pixel', { exempt, reasons: [...reasons, `design words in the request (${evidence.phrases}): pixel`] });
  if (judged.length === 0) return plan('none', { exempt, reasons });
  const tests = judged.some((f) => f.classes.includes('logic'));
  const found = screensOf(input);
  if (found.screens.length === 0) {
    const depth = evidence.design ? 'pixel' : 'visual';
    return plan(depth, { tests, exempt, reasons: [...reasons, `no inferable route (${found.unresolved[0] ?? 'no router, page or story found'}): ${depth} plan, visual-qa sets up its own matrix`] });
  }
  const needs = screenNeeds({ ...input, ...found }, judged, reasons);
  // Frames of the lane matrix that tie to no surface here: any look change may be on one of them, so every surface is pixel.
  const looseFrames = found.laneFramesLoose && judged.some((f) => f.classes.some((c) => LOOK_CLASSES.has(c)));
  if (looseFrames) reasons.push('the lane matrix has Figma frames its surfaces do not tie to this repository: pixel');
  if (evidence.design) reasons.push(`design words in the request (${evidence.phrases}): pixel`);
  const surfaces = needs.map((entry) => {
    const final = finalNeeds(entry, { evidence: { ...evidence, design: evidence.design || looseFrames }, baseIds: found.baseIds });
    return surfaceOf(entry.screen.id, final.needs, final.why.join('; '), entry.screen.urls[0] ?? null);
  });
  const depth = surfaces.reduce((max, s) => stricterDepth(max, s.need), evidence.design || looseFrames ? 'pixel' : 'none');
  return plan(depth, { tests, surfaces, exempt, reasons });
}

/** The request's evidence for the plan; a request over 1 MB counts as design (the full checks). */
function evidenceOf(requestText, reasons) {
  const found = requestEvidence(requestText ?? '');
  if (found.partial) reasons.push('the request is over 1 MB and was not read whole: pixel');
  return { design: found.partial || found.design.length > 0, noChange: found.noChange.length > 0, phrases: found.design.slice(0, 3).join(', ') || 'request over 1 MB' };
}

/**
 * The check plan of a change.
 * @param {{repoDir: string, base?: string, tip?: string, requestText?: string|null, matrixPath?: string|null, files?: string[]}} input
 *   base and tip: commits (the rebased lane); files instead: the expected files of a brief, judged by path at HEAD; requestText: the
 *   request itself, the brief (untrusted, only adds checks; never STATUS rules or decisions); matrixPath: the lane's ui-coverage
 *   matrix (Figma frames, widths, locales)
 * @returns {{depth: string, tests: boolean, surfaces: {id: string, need: string, needs: string[], why: string, url: string|null}[],
 *   exempt: {file: string, why: string}[], reasons: string[], map: object|null}} depth: the strictest need; tests: logic changed
 *   (done-check tests must be ok); needs: the surface's set of needs (`same` beside any other), need: the strictest of them; url: the
 *   first url of the surface (the runner's render); reasons: one line per safe path taken; map: the render map a same or render proof
 *   covers (ui-plan-proof.mjs renderMap), null without surfaces. Never throws: unreadable evidence is the pixel plan with its reason.
 */
export function planChecks({ repoDir, base, tip, requestText = '', matrixPath = null, files }) {
  const reasons = [];
  const { floor, bad } = floorOf(requestText);
  reasons.push(...bad);
  try {
    const evidence = evidenceOf(requestText, reasons);
    const laneMatrix = matrixPath ? { matrixPath, matrix: JSON.parse(fs.readFileSync(matrixPath, 'utf8')) } : null;
    const read = readChanges({ repoDir, base, tip, files });
    if (read.changes.length === 0) return withFloor(plan('none', { reasons: [...reasons, 'empty diff: nothing changed'] }), floor, () => []);
    const sorted = sortFiles(read.changes);
    const result = planFiles({ repoDir, laneMatrix, ...read }, { ...sorted, evidence, reasons });
    const floored = withFloor(result, floor, () => inferScreens({ repoDir, rev: read.tipRev }).screens);
    if (floored.surfaces.length === 0) return floored;
    return { ...floored, map: renderMap({ paths: [...readTree(repoDir, read.tipRev).keys()], laneMatrix: laneMatrix?.matrix ?? null, surfaces: floored.surfaces }) };
  } catch (error) {
    return plan('pixel', { tests: true, reasons: [...reasons, `evidence unreadable (${String(error?.message ?? error).split('\n')[0].slice(0, 200)}): pixel, the full checks`] });
  }
}

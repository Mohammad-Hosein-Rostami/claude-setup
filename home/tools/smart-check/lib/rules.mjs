// Purpose: the smart check's rule table (round 2, 8.3 with the UI rule of 9.1-9.2 and the review triggers of 8.4): change facts in,
//   one row per check kind out, each at none | scoped | full with one reason line.
// Exports: CHECK_KINDS, LEVELS, CATEGORY_OF, planRows(facts, context), raiseLevel(level), proseHasCommands(files), REVIEW_LENS_MAX_LINES.
// Invariants: pure and deterministic (exploration and the model are applied by plan.mjs after this, and only ever raise a level).
//   The first matching rule of a kind wins; a fact the rules cannot read picks the heavier level. Pinned checks are not rows here:
//   they always run (lib/pinned.mjs). A kind whose category the owner turned on with /check is `full`, by `owner`: its own gate runs it.
export const CHECK_KINDS = ['types', 'lint', 'build', 'tests', 'review', 'visual', 'security', 'probes'];
export const LEVELS = ['none', 'scoped', 'full'];
/** The /check category that owns each kind. */
export const CATEGORY_OF = { types: 'types', lint: 'types', build: 'types', tests: 'test', review: 'review', visual: 'ui', security: null, probes: 'probe' };
export const REVIEW_LENS_MAX_LINES = 150; // a cheap lens past this misses most findings (round 1, 4: F1 0.043 over 150 lines)
const DEEP_DIRS = 4; // round 2, 8.3 review "full": >= 4 directories or >= 20 files
const DEEP_FILES = 20;
const MEDIUM_LINES = 50; // above this a code change gets the cheap lens even with no other risk signal
const PROSE_ONLY = /\.(md|mdx|txt|rst)$/;
const COMMAND_LIKE = /`|--[a-z]|\$\(|(^|\s)(\.{0,2}\/|~\/)[\w.-]/;

/** One level up (full stays full). */
export const raiseLevel = (level) => LEVELS[Math.min(LEVELS.length - 1, LEVELS.indexOf(level) + 1)];
const row = (check, level, reason, how = '') => ({ check, level, reason, how, by: 'rule' });
const list = (paths, max = 3) => (paths.length <= max ? paths.join(', ') : `${paths.slice(0, max).join(', ')} +${paths.length - max}`);
const noCode = (facts) => facts.code.files.length === 0;

function typesRow(facts, project) {
  const { triggers, code } = facts;
  if (!project.tsconfig) return row('types', 'none', 'no tsconfig in this repo (parse and imports are pinned)');
  if (triggers.tsconfig.length) return row('types', 'full', `compiler options changed: ${list(triggers.tsconfig)}`, 'tsc whole project');
  if (triggers.typesPackages || triggers.lockfile.length) return row('types', 'full', 'TypeScript, @types or the lockfile changed', 'tsc whole project');
  if (triggers.globalDts) return row('types', 'full', `global or ambient .d.ts changed: ${list(code.dts)}`, 'tsc whole project');
  if (noCode(facts)) return row('types', 'none', 'no TS or JS file changed');
  if (code.astEqual) return row('types', 'none', 'formatting or comments only');
  const tops = new Set(code.exportsChanged.map((path) => path.split('/')[0]));
  if (tops.size >= 2 && !project.references) return row('types', 'full', `exports changed in ${tops.size} packages, no project references`, 'tsc whole project');
  return row('types', 'scoped', code.exportsChanged.length ? `exports changed in ${list(code.exportsChanged)}` : `${code.files.length} code file(s) changed`, 'incremental tsc of the owning project');
}

function lintRow(facts, project) {
  if (!project.lint) return row('lint', 'none', 'no lint config in this repo');
  if (facts.triggers.lintConfig.length) return row('lint', 'full', `lint config changed: ${list(facts.triggers.lintConfig)}`, 'eslint on the whole project');
  if (noCode(facts)) return row('lint', 'none', 'no code file changed');
  if (facts.code.astEqual) return row('lint', 'none', 'formatting or comments only');
  return row('lint', 'scoped', `${facts.code.files.length} code file(s), config unchanged`, 'eslint --cache on changed files, output on added lines only');
}

function buildRow(facts, project) {
  if (facts.triggers.build.length) return row('build', 'full', `build trigger changed: ${list(facts.triggers.build)}`, project.build ? 'the build script' : 'no build script: reported only');
  const entries = facts.code.exportsChanged.filter((path) => /(^|\/)(src\/)?(index|main)\.[cm]?[jt]sx?$/.test(path));
  if (entries.length && project.build) return row('build', 'scoped', `public entry changed: ${list(entries)}`, 'build of the touched package');
  return row('build', 'none', 'no bundler, entry, env or dependency file changed');
}

function testsRow(facts, project, context) {
  const { triggers, code, stats } = facts;
  if (!project.tests) return row('tests', 'none', 'no test command in this repo');
  if (triggers.testRunner.length) return row('tests', 'full', `test runner, package.json or lockfile changed: ${list(triggers.testRunner)}`, 'full suite');
  if (stats.truncated) return row('tests', 'full', `change too spread out to trace (${stats.files} files)`, 'full suite');
  if (context.affectedShare > 0.5) return row('tests', 'full', `affected set is ${Math.round(context.affectedShare * 100)}% of the suite`, 'full suite');
  if (noCode(facts) && triggers.tests.length === 0 && !context.textReadByTests) return row('tests', 'none', 'no code or test file changed');
  if (code.astEqual && triggers.tests.length === 0) return row('tests', 'none', 'formatting or comments only');
  const extra = triggers.tests.length ? ` + ${triggers.tests.length} changed test file(s)` : '';
  return row('tests', 'scoped', `import graph of ${code.files.length} code file(s)${extra}`, 'affected tests + always-include');
}

/** The deep-review trigger of a change, or '' (round 2, 8.3 review "full" and 8.4). */
function deepTrigger(facts, context) {
  const risky = facts.riskyClasses.filter((cls) => cls !== 'gate');
  if (risky.length) return `risky class: ${risky.join(', ')}`;
  const gateCode = facts.paths.filter((path) => facts.kinds[path]?.includes('gate') && !PROSE_ONLY.test(path));
  if (gateCode.length) return `gate file changed: ${list(gateCode)}`;
  if (facts.stats.dirs >= DEEP_DIRS || facts.stats.files >= DEEP_FILES) return `spread out: ${facts.stats.files} files in ${facts.stats.dirs} directories`;
  const caught = facts.paths.filter((path) => context.recentCatches?.has(path));
  if (caught.length) return `a past catch within 90 days in ${list(caught)}`;
  if (context.riskTopDecile) return 'risk score in the top tenth of the ledger';
  return '';
}

function reviewRow(facts, context) {
  const { stats, code, paths } = facts;
  const changed = stats.added + stats.deleted;
  if (paths.length === 0 || code.astEqual) return row('review', 'none', 'formatting or comments only');
  if (paths.every((path) => facts.triggers.lockfile.includes(path))) return row('review', 'none', 'lockfile only (written by the package manager)');
  const deep = deepTrigger(facts, context);
  if (deep) return row('review', 'full', deep, 'deep: the review-tier set');
  const prose = paths.every((path) => PROSE_ONLY.test(path));
  if (prose && !context.proseHasCommands) return row('review', 'none', 'prose only: no command, path or flag in the changed lines');
  const gateText = paths.filter((path) => facts.kinds[path]?.includes('gate'));
  if (gateText.length) return row('review', 'scoped', `gate text changed: ${list(gateText)}`, 'cheap lens: does the text weaken a check?');
  const medium = stats.newFiles > 0 || code.exportsChanged.length > 0 || changed > MEDIUM_LINES || stats.dirs >= 2 || prose;
  if (!medium) return row('review', 'none', `low risk: ${changed} lines, no risky path, no new file or export`);
  const how = changed > REVIEW_LENS_MAX_LINES ? `diff ${changed} lines > ${REVIEW_LENS_MAX_LINES}: per directory group, else suggest a split` : 'cheap lens: one fresh Haiku pass on the diff';
  return row('review', 'scoped', stats.newFiles ? `${stats.newFiles} new file(s)` : `${changed} lines in ${stats.dirs} dir(s)`, how);
}

/** The UI rule (round 2, 9.2): crop only for a local paint or inner-spacing change; the matrix for anything that can reflow. */
function visualRow(facts, context) {
  const { css } = facts;
  if (css.uiFiles.length === 0) return row('visual', 'none', 'no rendered file reached');
  if (context.figmaJob) return row('visual', 'full', 'a Figma or pixel-perfect job reached a screen', 'visual-qa once at the end of the lane');
  const why = [
    css.layout.length && `layout: ${list(css.layout)}`, css.mediaOrContainer && 'media or container query', css.scope !== 'local' && `${css.scope} scope`,
    css.tokensOrTheme && 'tokens or theme', css.rtlOrLocale && 'RTL or locale text', css.newComponent && 'new component', css.newState && 'new or changed state',
    css.unknown && 'styles the rules cannot classify',
  ].filter(Boolean);
  if (why.length) return row('visual', 'full', why.join('; '), 'width x state matrix');
  const what = [...css.paint, ...css.spacing];
  return row('visual', 'scoped', what.length ? `local paint or spacing: ${list(what)}` : 'local markup change', 'crop at 3 widths: 320, design width, one breakpoint edge');
}

function securityRow(facts) {
  const deps = facts.code.newBareImports;
  const audit = facts.triggers.lockfile.length ? '; lockfile changed: dependency audit not run (it sends the tree, the owner allowed lookups by name only)' : '';
  return row('security', 'scoped', `pinned: secrets on added lines${deps.length ? `, ${deps.length} new package(s) looked up by name` : ''}${audit}`, 'pinned');
}

function probesRow(facts) {
  if (facts.triggers.hooks.length) return row('probes', 'scoped', `hook changed: ${list(facts.triggers.hooks)}`, 'each hook loads and passes an empty input');
  return row('probes', 'none', 'no hook changed');
}

/**
 * The plan rows of one change.
 * @param {object} facts from changeFacts
 * @param {{project: {tsconfig: boolean, references: boolean, lint: boolean, build: boolean, tests: boolean}, ownerOn?: string[],
 *   figmaJob?: boolean, affectedShare?: number, textReadByTests?: boolean, recentCatches?: Set<string>, riskTopDecile?: boolean,
 *   proseHasCommands?: boolean}} context what plan.mjs read from the repo, the switch and the ledger
 * @returns {{check: string, level: string, reason: string, how: string, by: string}[]} one row per CHECK_KINDS entry, in order
 */
export function planRows(facts, context) {
  const { project } = context;
  const rows = [typesRow(facts, project), lintRow(facts, project), buildRow(facts, project), testsRow(facts, project, context),
    reviewRow(facts, context), visualRow(facts, context), securityRow(facts), probesRow(facts)];
  const ownerOn = new Set(context.ownerOn ?? []);
  return rows.map((planned) => (ownerOn.has(CATEGORY_OF[planned.check])
    ? { ...planned, level: 'full', by: 'owner', reason: `/check ${CATEGORY_OF[planned.check]} is on: its own gate runs it`, how: 'owner gate' }
    : planned));
}

/** True when a prose change has a command, path or flag in its changed lines (then it is not a typo fix). */
export const proseHasCommands = (files) => files.filter(({ path }) => PROSE_ONLY.test(path)).some((file) => [...file.added, ...file.removed].some(({ text }) => COMMAND_LIKE.test(text)));

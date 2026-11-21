// Purpose: the change facts the smart check's rules read (round 2, 8.1): change kinds from review-tier's classes, diff stats, symbol
//   facts from a line-level read of changed JS/TS (no type checker), CSS facts, the global triggers and the job kind.
// Exports: changeFacts(files, options), bareName(specifier), LAYOUT_PROPS, PAINT_PROPS, isGlobalTrigger(path), CODE_FILE, STYLE_FILE.
// Invariants: pure: reads only what `files` and the given readers return; never throws on odd text (a fact it cannot read is
//   `unknown`, which the rules treat as the heavier level). Line texts are matched in memory and never stored in the facts.
import { builtinModules } from 'node:module';
import { classifyFiles, RISKY_CLASSES } from '../../review-tier/tiers.mjs';
import { cssFacts } from './css-facts.mjs';

export const CODE_FILE = /\.(m?[jt]sx?|cjs|cts|mts)$/;
export const STYLE_FILE = /\.(css|scss|sass|less)$/;
export { LAYOUT_PROPS, PAINT_PROPS } from './css-facts.mjs';
const DTS = /\.d\.[cm]?ts$/;
const LOCKFILE = /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|npm-shrinkwrap\.json|bun\.lockb?)$/;
const ROOT_TOOL_CONFIG = /^([^/]+\.config\.[cm]?[jt]s|\.eslintrc[^/]*|eslint\.config\.[^/]+|\.prettierrc[^/]*|babel\.config\.[^/]+|\.babelrc|nx\.json|turbo\.json|lerna\.json|pnpm-workspace\.yaml|\.npmrc|\.nvmrc)$/;
const TSCONFIG = /(^|\/)tsconfig[^/]*\.json$/;
const ENV_FILE = /(^|\/)\.env[^/]*$|(^|\/)env\.(schema\.)?[cm]?[jt]s$/;
const BUILD_TRIGGER = /(^|\/)(vite|webpack|rollup|next|nuxt|astro|svelte|remix|tsup|esbuild)\.config\.[^/]+$|(^|\/)\.storybook\/|(^|\/)(dockerfile|makefile)$|(^|\/)index\.html$|(^|\/)(public|static)\/|(^|\/)(app|pages)\/.*(page|layout|route)\.[jt]sx?$|\.(graphql|gql|proto)$|(^|\/)schema\.prisma$/i;
const TEST_RUNNER = /(^|\/)(vitest|jest|playwright)\.(config|workspace|setup)[^/]*$|(^|\/)(setup-?tests|test-setup|test-helpers?)\.[cm]?[jt]s$|(^|\/)tests\/[^/]*helpers?\.[cm]?[jt]s$/i;
const LINT_CONFIG = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[^/]+|\.stylelintrc[^/]*|biome\.json)$/;
const HOOK_FILE = /(^|\/)(home\/hooks|\.githooks|\.claude\/hooks|\.husky)\//;
const CLI_FILE = /(^|\/)(home\/tools\/[^/]+\/[^/]+\.mjs|scripts\/[^/]+\.(mjs|sh)|bin\/[^/]+)$/;
const EXPORT_LINE = /^\s*export\b|module\.exports\b|^\s*exports\.\w+\s*=/;
const IMPORT_SPEC = /(?:^|\s)(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]|\b(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/;
const COMMENT_ONLY = /^\s*(\/\/.*|\/\*.*\*\/|\*.*|\/\*.*|\*\/)?\s*$/;
const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const DOC_ONLY = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp)$/i;

/** True for a change that makes a scoped check unsafe (round 2, 8.3 "full"): lockfile, root or tool config, tsconfig, env. */
export const isGlobalTrigger = (path) => LOCKFILE.test(path) || TSCONFIG.test(path) || ROOT_TOOL_CONFIG.test(path) || path === 'package.json' || ENV_FILE.test(path) || (DTS.test(path) && !path.includes('/'));

/** The import specifier a line names, or null. */
function specifierOf(text) {
  const match = IMPORT_SPEC.exec(text);
  return match ? match[1] ?? match[2] ?? match[3] : null;
}

/** The bare package name of a specifier (`@a/b/c` -> `@a/b`, `x/y` -> `x`), or null for a relative, absolute or builtin one. */
export function bareName(specifier) {
  if (!specifier || /^[./#~]/.test(specifier) || BUILTINS.has(specifier) || specifier.startsWith('node:') || /^[a-z]+:/i.test(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The code text of a line without whitespace and a trailing line comment (for the formatting-only test). */
const codeOf = (text) => (COMMENT_ONLY.test(text) ? '' : text.replace(/\s+\/\/.*$/, '').replace(/\s+/g, ''));

/** Symbol facts of one JS/TS file: exports changed, new imports, new bare imports, formatting or comments only. */
function symbolFacts(file) {
  const removedSpecs = new Set(file.removed.map(({ text }) => specifierOf(text)).filter(Boolean));
  const newImports = [...new Set(file.added.map(({ text }) => specifierOf(text)).filter((spec) => spec && !removedSpecs.has(spec)))];
  const exportsOf = (lines) => lines.filter(({ text }) => EXPORT_LINE.test(text)).map(({ text }) => text.trim()).sort().join('\n');
  const before = file.removed.map(({ text }) => codeOf(text)).join('');
  const after = file.added.map(({ text }) => codeOf(text)).join('');
  return {
    exportsChanged: exportsOf(file.added) !== exportsOf(file.removed),
    newImports,
    newBareImports: [...new Set(newImports.map(bareName).filter(Boolean))],
    astEqual: !file.isNew && before === after,
  };
}

/** Diff stats: lines added and deleted, files, directories, new files. */
function diffStats(files) {
  const dirs = new Set(files.map(({ path }) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')));
  return {
    files: files.length, dirs: dirs.size, newFiles: files.filter((file) => file.isNew).length,
    added: files.reduce((sum, file) => sum + file.added.length, 0), deleted: files.reduce((sum, file) => sum + file.removed.length, 0),
  };
}

/** The job kind when the caller gave none: from the change itself. */
function jobKindOf(given, kinds, files) {
  if (given) return given;
  if (files.length > 0 && files.every(({ path }) => DOC_ONLY.test(path) || kinds[path]?.[0] === 'docs')) return 'docs';
  if (files.some(({ path }) => HOOK_FILE.test(path) || kinds[path]?.includes('gate'))) return 'hooks-or-gates';
  if (files.some(({ path }) => isGlobalTrigger(path))) return 'config';
  return 'code';
}

/**
 * The facts of one change.
 * @param {{path: string, added: {line: number, text: string}[], removed: {line: number, text: string}[], isNew: boolean}[]} files
 * @param {{readNew: (path: string) => string | null, jobKind?: string, consumersOf?: (path: string) => number, truncated?: boolean}} options
 * @returns {object} paths, kinds (path -> classes), riskyClasses, stats, code (per-file symbol facts summed), css, triggers, jobKind
 */
export function changeFacts(files, { readNew, jobKind, consumersOf = () => 0, truncated = false }) {
  const { fileClasses, triggers: tierTriggers } = classifyFiles(files, readNew);
  const codeFiles = files.filter(({ path }) => CODE_FILE.test(path));
  const perFile = codeFiles.map((file) => ({ path: file.path, ...symbolFacts(file) }));
  const paths = files.map(({ path }) => path);
  const risky = [...new Set(Object.values(fileClasses).flat().filter((cls) => RISKY_CLASSES.includes(cls) || cls === 'audit' || cls === 'gate'))];
  return {
    paths, kinds: fileClasses, riskyClasses: risky, stats: { ...diffStats(files), truncated }, tierTriggers: [...tierTriggers],
    code: {
      files: codeFiles.map(({ path }) => path),
      exportsChanged: perFile.filter((f) => f.exportsChanged).map((f) => f.path),
      newImports: [...new Set(perFile.flatMap((f) => f.newImports))],
      newBareImports: [...new Set(perFile.flatMap((f) => f.newBareImports))],
      astEqual: perFile.length > 0 && perFile.every((f) => f.astEqual),
      dts: paths.filter((path) => DTS.test(path)),
    },
    css: cssFacts(files, { readNew, consumersOf }),
    triggers: {
      global: paths.filter(isGlobalTrigger), lockfile: paths.filter((path) => LOCKFILE.test(path)), tsconfig: paths.filter((path) => TSCONFIG.test(path)),
      build: paths.filter((path) => BUILD_TRIGGER.test(path) || LOCKFILE.test(path) || ENV_FILE.test(path)),
      testRunner: paths.filter((path) => TEST_RUNNER.test(path) || path === 'package.json' || LOCKFILE.test(path)),
      lintConfig: paths.filter((path) => LINT_CONFIG.test(path)), hooks: paths.filter((path) => HOOK_FILE.test(path)),
      cli: paths.filter((path) => CLI_FILE.test(path)), tests: paths.filter((path) => fileClasses[path]?.includes('tests')),
      typesPackages: files.filter(({ path }) => path.endsWith('package.json')).some((file) => file.added.some(({ text }) => /"(@types\/[^"]+|typescript)"\s*:/.test(text))),
      globalDts: files.filter(({ path }) => DTS.test(path)).some((file) => !file.path.includes('/') || /\bdeclare\s+(global|module)\b/.test(readNew(file.path) ?? '')),
    },
    jobKind: jobKindOf(jobKind, fileClasses, files),
  };
}

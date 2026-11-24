#!/usr/bin/env node
// Purpose: say which risk classes a change falls in (security, data, money, concurrency, gate, large), so the boss knows whether
//   landing waits for tess. Runs only when called; no hook or setting calls it.
// Usage: node ~/.claude/tools/risk/risk.mjs --base <rev> [--tip <rev>] [--repo <dir>] [--json]
//   The change is the merge base of <base> and <tip> against <tip>; without --tip, against the worktree (uncommitted and untracked
//   files included). --repo is any folder inside the repository (default: the current folder).
// Output (one line on stdout): `risk: none (<n> lines, <m> files)`, `risk: <class>[, <class>]... (<n> lines, <m> files)` with the
//   classes in the fixed order of CLASS_ORDER, or `risk: unknown (<why>)`. With --json, a classified change prints
//   {"classes":[{"class","file"}],"lines","files"} instead. Lines and files count every changed file, tests and docs included (the
//   `large` class leaves those out; see README.md).
// Exports: none (a CLI). Exit codes: 0 classified (none included), 1 unknown (git failed, a bad revision, not a repository), 2 usage.
// Invariants: never writes; an error is never read as `none`: it is `unknown`, which counts as risky.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { rangeScope } from './lib/range.mjs';
import { changedLineCount, loadRiskRules, riskClasses } from './lib/risk.mjs';

const USAGE = 'usage: node ~/.claude/tools/risk/risk.mjs --base <rev> [--tip <rev>] [--repo <dir>] [--json]';
const EXIT_CLASSIFIED = 0;
const EXIT_UNKNOWN = 1;
const EXIT_USAGE = 2;
const CLASS_ORDER = ['security', 'data', 'money', 'concurrency', 'gate', 'large']; // a class the rule file adds comes after these
const MAX_REASON_CHARS = 200;
const OPTIONS = { base: { type: 'string' }, tip: { type: 'string' }, repo: { type: 'string' }, json: { type: 'boolean' } };

/** The options, or null when the arguments are not a valid call (unknown option, positional word, no --base). */
function readOptions(argv) {
  try {
    const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false });
    return values.base === undefined ? null : values;
  } catch (error) {
    if (error?.code?.startsWith('ERR_PARSE_ARGS_')) return null;
    throw error;
  }
}

const orderOf = (name) => (CLASS_ORDER.includes(name) ? CLASS_ORDER.indexOf(name) : CLASS_ORDER.length);

/** The one summary line of a classified change. */
function summaryLine(found, lines, files) {
  const names = [...new Set(found.map((entry) => entry.class))];
  return `risk: ${names.length > 0 ? names.join(', ') : 'none'} (${lines} lines, ${files} files)`;
}

/** Classifies the change the arguments name and prints one line; returns the exit code. */
async function main(argv) {
  const options = readOptions(argv);
  if (options === null) {
    console.error(USAGE);
    return EXIT_USAGE;
  }
  try {
    const scope = await rangeScope(resolve(options.repo ?? '.'), options.base, options.tip ?? null);
    const { rules, warning } = loadRiskRules();
    if (warning !== null) console.error(warning);
    const found = (await riskClasses(scope, rules)).sort((a, b) => orderOf(a.class) - orderOf(b.class));
    const lines = changedLineCount(scope, scope.files);
    const files = scope.files.length;
    console.log(options.json ? JSON.stringify({ classes: found, lines, files }) : summaryLine(found, lines, files));
    return EXIT_CLASSIFIED;
  } catch (error) {
    const reason = String(error?.message ?? error).split('\n')[0].slice(0, MAX_REASON_CHARS);
    console.log(`risk: unknown (${reason})`);
    return EXIT_UNKNOWN;
  }
}

process.exitCode = await main(process.argv.slice(2));

// Prints the approximate token cost of a session start and an agent start for the Claude config visible from cwd, the recurring
// parts one by one, and each project's MEMORY.md size. ~tokens = bytes / 4 (hook text: characters / 4). A manual CLI, not a hook
// event handler. `--budget` prints only the status lines `scripts/doctor.sh` reads: `<ok|warn|fail><TAB><message>`. The per-run
// use (roles, lanes, cache, waste) is the token view: `node ~/.claude/tools/token-view/token-view.mjs`.
// Hook text: each start hook (lead-text.mjs, session-notes.mjs, recall-digest.mjs) runs as Claude Code runs it, a child process given a
// startup input on stdin, but with HOME set to a throwaway folder holding copies of the files it reads at a start (START_FILES); only
// the length of its stdout is used (hookTextParts). The throwaway folder is removed after the run.
// Exports: hookTextParts(parts, timeoutMs), startLines(sizeOf, parts), HOOK_PARTS, PART_TIMEOUT_MS.
// Invariants: nothing of the owner's is written: a hook can only write inside the throwaway HOME (session-notes prunes its state
// folder there), and its environment holds only PATH, SystemRoot and that HOME; hook text (lead rules, STATUS.md and memory text) is
// measured, never printed (hook stderr is dropped); every file is read as a plain file of at most CONFIG_MAX_BYTES without waiting or
// following a final link (lib/plain-file.mjs), so a FIFO never hangs the audit; a hook file that is missing, fails or runs past
// PART_TIMEOUT_MS is listed as not counted with its reason and the total says "at least"; exit 0.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPlainFile } from './lib/plain-file.mjs';

export const PART_TIMEOUT_MS = 5000; // the timeout of the lead-text and session-notes entries in settings/base.json
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url)); // the resolved folder: ~/.claude/hooks links into the repo
const AUDIT_ID = 'token-audit'; // the session and agent id of the measuring inputs (passes SESSION_ID_PATTERN)
const REASON_MAX_CHARS = 120;
const CONFIG_MAX_BYTES = 1024 * 1024; // config text is a few KB; the hooks' own read caps are far below this
const THROWAWAY_PREFIX = 'cs-test-token-audit-'; // disk-clean removes the folder a killed run leaves behind
const START_FILES = ['lead.md', 'lead-rules.md']; // what the start hooks read from ~/.claude at a fresh start
const CHILD_ENV_NAMES = ['PATH', 'SystemRoot']; // what node needs to start; nothing else of this environment reaches a hook
const SESSION_START_CAP_CHARS = 10_000; // a SessionStart hook string over this reaches Claude as a file path (hooks docs)
const SESSION_START_WARN_CHARS = 9_000; // warn while there is still room for a few lines
const LEAD_PART = 'lead text (lead-text.mjs)';

const tok = (b) => Math.ceil(b / 4);
const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const reasonOf = (error) => String(error?.message ?? error).split('\n')[0].slice(0, REASON_MAX_CHARS);

/**
 * The text of a config file: an install link is followed once, the open itself never waits and follows no link.
 * @param {string} path - the file.
 * @returns {string | null} its text; null when it is missing (silent) or is a FIFO, device, folder or over CONFIG_MAX_BYTES (stderr
 *   names the path and the reason, never the text).
 */
function readConfig(path) {
  try {
    return readPlainFile(realpathSync(path), CONFIG_MAX_BYTES);
  } catch (error) {
    if (error.code !== 'ENOENT') process.stderr.write(`token-audit: not counted: ${path}: ${reasonOf(error)}\n`);
    return null;
  }
}

/** A throwaway HOME with copies of START_FILES (a file that cannot be read is left out, as the hook would print nothing of it). */
function throwawayHome() {
  const home = mkdtempSync(join(tmpdir(), THROWAWAY_PREFIX));
  mkdirSync(join(home, '.claude'));
  for (const name of START_FILES) {
    const text = readConfig(join(homedir(), '.claude', name));
    if (text !== null) writeFileSync(join(home, '.claude', name), text);
  }
  return home;
}

/**
 * The SessionStart input of a fresh start; with `agentId`, the one Claude Code sends inside an agent. The session folder is the
 * throwaway HOME: session-notes' project-agents walk stops at the home folder, so that note (printed only on a finding) stays out.
 */
const startInput = (home, agentId) =>
  ({ hook_event_name: 'SessionStart', source: 'startup', session_id: AUDIT_ID, cwd: home, ...(agentId ? { agent_id: agentId } : {}) });

/** One part of a start's hook text: `input` builds the hook input for the throwaway HOME. */
const hookPart = (part, when, file, agentId) => ({ part, when, script: join(HOOKS_DIR, file), input: (home) => startInput(home, agentId) });

/** The hook text of a start: one entry per hook and start kind. */
export const HOOK_PARTS = [
  hookPart(LEAD_PART, 'main', 'lead-text.mjs'),
  hookPart('lead rules (session-notes.mjs)', 'main', 'session-notes.mjs'),
  hookPart('checkpoint digest (recall-digest.mjs, only after a compaction)', 'main', 'recall-digest.mjs'),
  hookPart('compaction note (session-notes.mjs, only after a compaction)', 'agent', 'session-notes.mjs', AUDIT_ID),
];

/** One part's printed size (its whole stdout, the newline of console.log included), or null with the reason it is not counted. */
function measurePart({ part, when, script, input }, home, timeoutMs) {
  if (!existsSync(script)) return { part, when, chars: null, why: 'missing' };
  const env = { HOME: home, USERPROFILE: home };
  for (const name of CHILD_ENV_NAMES) if (process.env[name] !== undefined) env[name] = process.env[name];
  const run = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input(home)),
    env,
    cwd: home,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['pipe', 'pipe', 'ignore'], // hook stderr may quote what it read: dropped
    windowsHide: true,
  });
  // Claude Code drops the whole output of a hook that passes its timeout.
  if (run.error?.code === 'ETIMEDOUT') return { part, when, chars: null, why: `ran past ${timeoutMs / 1000} s` };
  if (run.error) return { part, when, chars: null, why: reasonOf(run.error) };
  if (run.status !== 0) return { part, when, chars: null, why: `exit ${run.status ?? run.signal}` };
  return { part, when, chars: run.stdout.length };
}

/**
 * The size of each start hook's text, measured by running the hook in a throwaway HOME (nothing it prints is kept or printed).
 * @param {{ part: string, when: 'main' | 'agent', script: string, input: (home: string) => object }[]} [parts] - tests pass others.
 * @param {number} [timeoutMs] - how long one hook may run.
 * @returns {Promise<{ part: string, when: 'main' | 'agent', chars: number | null, why?: string }[]>} chars null: not counted, `why` says why.
 */
export async function hookTextParts(parts = HOOK_PARTS, timeoutMs = PART_TIMEOUT_MS) {
  const home = throwawayHome();
  try {
    return parts.map((part) => measurePart(part, home, timeoutMs)); // one at a time, like hooks that each own a process
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const KIND_NAMES = {
  'always-loaded': 'CLAUDE.md and AGENTS.md',
  'rule(ALWAYS)': 'rules without paths:',
  'skill-listing': 'skill descriptions',
  'agent-listing': 'agent descriptions',
  mcp: 'MCP servers (estimate)',
};
const START_KINDS = { main: Object.keys(KIND_NAMES), agent: ['always-loaded', 'rule(ALWAYS)', 'skill-listing', 'mcp'] }; // an agent cannot start agents
const START_LABELS = { main: 'main session start', agent: 'agent start' };
const NOT_COUNTED = {
  main: [
    "Claude Code's own system prompt and tool definitions",
    'plugin skills, agents and MCP tools',
    'start hooks that print only when they find something (resume-notice.mjs, git-tidy-gate.mjs, the project-agents note of session-notes.mjs)',
    'after a resume or compaction: the STATUS.md digest (recall-digest.mjs --part rules, --part state)',
  ],
  agent: ["the agent file's own text (start tokens per role: tools/token-view)", 'the brief', "Claude Code's tool definitions", 'plugin skills and MCP tools'],
};

/**
 * The two start totals, each with every part counted and every part not counted.
 * @param {(kind: string) => number} sizeOf - bytes of one kind of config row.
 * @param {{ part: string, when: 'main' | 'agent', chars: number | null, why?: string }[]} parts - from hookTextParts.
 * @returns {string[]} three lines per start; a total with a part not counted says "at least".
 */
export function startLines(sizeOf, parts) {
  const lines = [];
  for (const when of ['main', 'agent']) {
    const own = parts.filter((p) => p.when === when);
    const missed = own.filter((p) => p.chars === null);
    const counted = [
      ...START_KINDS[when].map((kind) => [KIND_NAMES[kind], tok(sizeOf(kind))]),
      ...own.filter((p) => p.chars !== null).map((p) => [p.part, tok(p.chars)]),
    ];
    const total = counted.reduce((n, [, t]) => n + t, 0);
    const atLeast = missed.length ? ` at least (${missed.length} hook part${missed.length > 1 ? 's' : ''} not counted)` : '';
    lines.push(`${START_LABELS[when]}: about ${short(total)} tok${atLeast}`);
    lines.push(`  counted: ${counted.map(([name, t]) => `${name} ${short(t)}`).join(', ')}`);
    lines.push(`  not counted: ${[...missed.map((p) => `${p.part}: not counted (${p.why})`), ...NOT_COUNTED[when]].join('; ')}`);
  }
  return lines;
}

/** Frontmatter fields of a markdown file: only the leading `---` block is read; `>`/`|` values join indented lines. */
const frontmatter = (text) => {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = {};
  if (!block) return fields;
  const lines = block[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(paths|description):\s*(.*)$/);
    if (!m) continue;
    const parts = /^[>|][+-]?$/.test(m[2].trim()) ? [] : [m[2]];
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
    fields[m[1]] = parts.join(' ').trim();
  }
  return fields;
};

const walk = (dir, filter) => {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, filter));
    else if (filter(p)) out.push(p);
  }
  return out;
};

/** The budget status lines: the lead text string against its SessionStart cap, and the always-loaded size. */
function budgetLines(alwaysLoadedBytes, lead) {
  const chars = lead?.chars;
  let leadLine;
  if (typeof chars !== 'number') leadLine = `warn\tlead text not measured: ${lead?.why ?? 'no lead part'}`;
  else if (chars === 0) leadLine = 'warn\tlead text missing or empty at ~/.claude/lead.md (scripts/install.sh links it)';
  else {
    const level = chars > SESSION_START_CAP_CHARS ? 'fail' : chars > SESSION_START_WARN_CHARS ? 'warn' : 'ok';
    leadLine = `${level}\tlead text SessionStart string ${chars} chars (cap ${SESSION_START_CAP_CHARS}; over it the text becomes a file path)`;
  }
  return [leadLine, `ok\talways-loaded text ~${tok(alwaysLoadedBytes)} tok (CLAUDE.md files and rules without paths:)`];
}

/** Each project's auto-memory MEMORY.md: size and lines that appear more than once (a trim proposal, never applied here). */
function memoryRows() {
  const projects = join(homedir(), '.claude', 'projects');
  const out = [];
  for (const name of existsSync(projects) ? readdirSync(projects) : []) {
    const text = readConfig(join(projects, name, 'memory', 'MEMORY.md'));
    if (text === null) continue;
    const seen = new Map();
    for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) seen.set(line, (seen.get(line) ?? 0) + 1);
    const repeated = [...seen.values()].filter((n) => n > 1).reduce((n, count) => n + count - 1, 0);
    out.push({ name, chars: text.length, repeated });
  }
  return out.sort((a, b) => b.chars - a.chars);
}

/** The config rows of the user and project `.claude` folders and the cwd's CLAUDE.md, AGENTS.md and .mcp.json. */
function configRows(cwd) {
  const rows = [];
  const add = (kind, path, text) => rows.push({ kind, path, bytes: Buffer.byteLength(text), lines: text.split('\n').length });
  const userRoot = join(homedir(), '.claude');
  const projectRoot = join(cwd, '.claude');
  const roots = [['user', userRoot], ...(projectRoot === userRoot ? [] : [['project', projectRoot]])]; // cwd=~ would count twice
  for (const f of ['CLAUDE.md', 'AGENTS.md']) {
    const t = readConfig(join(cwd, f));
    if (t) add('always-loaded', f, t);
  }
  const ug = readConfig(join(userRoot, 'CLAUDE.md'));
  if (ug) add('always-loaded', '~/.claude/CLAUDE.md', ug);
  for (const [scope, root] of roots) {
    const name = (p) => `${scope}:${p.slice(root.length + 1).replace(/\\/g, '/')}`;
    for (const p of walk(join(root, 'rules'), (x) => x.endsWith('.md'))) {
      const t = readConfig(p);
      if (t === null) continue;
      add('paths' in frontmatter(t) ? 'rule(paths)' : 'rule(ALWAYS)', name(p), t);
    }
    for (const p of walk(join(root, 'skills'), (x) => x.endsWith('SKILL.md') && !x.includes('synced'))) {
      const t = readConfig(p);
      if (t === null) continue;
      add('skill-listing', name(p), frontmatter(t).description ?? '');
      add('skill-body', name(p), t);
    }
    for (const p of walk(join(root, 'agents'), (x) => x.endsWith('.md'))) {
      const t = readConfig(p);
      if (t !== null) add('agent-listing', name(p), frontmatter(t).description ?? '');
    }
  }
  const mcp = readConfig(join(cwd, '.mcp.json'));
  if (mcp) {
    let servers = [];
    try {
      servers = Object.keys(JSON.parse(mcp).mcpServers ?? {});
    } catch (error) {
      console.warn(`warning: .mcp.json unreadable, MCP cost not counted: ${error.message}`);
    }
    rows.push({ kind: 'mcp', path: servers.join(', '), bytes: servers.length * 400, lines: servers.length });
  }
  return rows;
}

/** The full report: the two start totals, the recurring kinds, the largest items, flags and the MEMORY.md sizes. */
function printReport(rows, sizeOf, parts) {
  for (const line of startLines(sizeOf, parts)) console.log(line);
  console.log('\nRecurring (every session):');
  for (const k of START_KINDS.main) console.log(`  ${k.padEnd(15)} ~${String(tok(sizeOf(k))).padStart(6)} tok`);
  console.log('On demand: rule(paths) / skill-body load only when matched or invoked.\n');
  console.log('Largest items:');
  [...rows]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 15)
    .forEach((r) => console.log(`  ${String(tok(r.bytes)).padStart(6)} tok  ${String(r.lines).padStart(4)}L  ${r.kind.padEnd(14)} ${r.path}`));
  const flags = rows.filter(
    (r) => (r.kind === 'always-loaded' && r.lines > 200) || r.kind === 'rule(ALWAYS)' || (r.kind === 'skill-body' && r.lines > 500),
  );
  if (flags.length) {
    console.log('\nFlags:');
    flags.forEach((r) => console.log(`  ! ${r.kind} ${r.path} (${r.lines} lines)`));
  }
  const memories = memoryRows();
  if (memories.length) {
    console.log('\nProject MEMORY.md (loaded in every session of that project; repeated = lines that appear more than once):');
    memories.forEach((m) => console.log(`  ${String(m.chars).padStart(6)} chars  repeated ${String(m.repeated).padStart(3)}  ${m.name}`));
  }
}

async function main() {
  const rows = configRows(process.cwd());
  const sizeOf = (k) => rows.filter((r) => r.kind === k).reduce((n, r) => n + r.bytes, 0);
  if (process.argv.includes('--budget')) {
    const [lead] = await hookTextParts(HOOK_PARTS.filter((p) => p.part === LEAD_PART));
    for (const line of budgetLines(sizeOf('always-loaded') + sizeOf('rule(ALWAYS)'), lead)) console.log(line);
  } else {
    printReport(rows, sizeOf, await hookTextParts());
  }
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

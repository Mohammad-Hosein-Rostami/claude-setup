// Prints the approximate token cost of a session start and an agent start for the Claude config visible from cwd, the recurring
// parts one by one, and each project's MEMORY.md size. ~tokens = bytes / 4 (hook text: characters / 4).
// A manual CLI (`node ~/.claude/hooks/token-audit.mjs`), not a hook event handler.
// `--budget` prints only the budget status lines `scripts/doctor.sh` reads: `<ok|warn|fail><TAB><message>`.
// The per-run use (roles, lanes, cache, waste) is the token view: `node ~/.claude/tools/token-view/token-view.mjs`.
// Hook text: the start hooks' own exported functions (lead-text.mjs leadText, session-notes.mjs hookText, recall-digest.mjs
// digestFor) are called with a startup input and only the length of what they return is used (hookTextParts).
// Exports: hookTextParts(parts, timeoutMs), startLines(sizeOf, parts), HOOK_PARTS, PART_TIMEOUT_MS.
// Invariants: read-only, also through the hook functions (session-notes' prune of old state files is never reached, see
// budgetSpentAfterFirstRead); hook text (lead rules, STATUS.md and memory text) is measured, never printed; a hook file that is
// missing, throws or runs past PART_TIMEOUT_MS is listed as not counted with its reason and the total says "at least"; exit 0.
import { readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PART_TIMEOUT_MS = 5000; // the timeout of the lead-text and session-notes entries in settings/base.json
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url)); // the resolved folder: ~/.claude/hooks links into the repo
const AUDIT_ID = 'token-audit'; // the session and agent id of the measuring inputs (passes SESSION_ID_PATTERN)
const REASON_MAX_CHARS = 120;
const SESSION_START_CAP_CHARS = 10_000; // a SessionStart hook string over this reaches Claude as a file path (hooks docs)
const SESSION_START_WARN_CHARS = 9_000; // warn while there is still room for a few lines
const LEAD_PART = 'lead text (lead-text.mjs)';

const tok = (b) => Math.ceil(b / 4);
const short = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const tryRead = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** The SessionStart input of a fresh start in this folder; with `agentId`, the one Claude Code sends inside an agent. */
const startInput = (agentId) => ({
  hook_event_name: 'SessionStart',
  source: 'startup',
  session_id: AUDIT_ID,
  cwd: process.cwd(),
  ...(agentId ? { agent_id: agentId } : {}),
});

/**
 * The clock passed to session-notes' hookText: its first reading (the project-agents child, which only reads) sees the whole
 * budget, every later reading (the prune of old state files, which deletes) sees it used up, so the audit gets the full text and
 * changes no file. tests/token-audit.test.mjs pins this with a stale state file that must survive.
 */
function budgetSpentAfterFirstRead(budgetMs) {
  let reads = 0;
  return () => (reads++ === 0 ? 0 : budgetMs);
}

/** The hook text of a start: one entry per hook function and start kind (`measure` gets the imported hook module). */
export const HOOK_PARTS = [
  { part: LEAD_PART, when: 'main', file: 'lead-text.mjs', measure: (hook) => hook.leadText(startInput()) },
  {
    part: 'lead rules and notes (session-notes.mjs)',
    when: 'main',
    file: 'session-notes.mjs',
    measure: (hook) => hook.hookText(startInput(), { now: budgetSpentAfterFirstRead(hook.HOOK_BUDGET_MS) }),
  },
  { part: 'checkpoint digest (recall-digest.mjs)', when: 'main', file: 'recall-digest.mjs', measure: (hook) => hook.digestFor(startInput()) },
  { part: 'agent start note (session-notes.mjs)', when: 'agent', file: 'session-notes.mjs', measure: (hook) => hook.hookText(startInput(AUDIT_ID)) },
];

const LATE = Symbol('late');
const reasonOf = (error) => String(error?.message ?? error).split('\n')[0].slice(0, REASON_MAX_CHARS);

/** One part's printed size: the text plus the newline the hook's console.log adds, or null with the reason it is not counted. */
async function measurePart({ part, when, file, measure }, timeoutMs) {
  const path = join(HOOKS_DIR, file);
  if (!existsSync(path)) return { part, when, chars: null, why: 'missing' };
  const started = performance.now();
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs, LATE);
  });
  try {
    const text = await Promise.race([import(pathToFileURL(path).href).then(measure), late]);
    // Claude Code drops the whole output of a hook that passes its timeout; a synchronous overrun is caught by the clock.
    if (text === LATE || performance.now() - started > timeoutMs) return { part, when, chars: null, why: `ran past ${timeoutMs / 1000} s` };
    if (typeof text !== 'string') return { part, when, chars: null, why: 'returned no text' };
    return { part, when, chars: text ? text.length + 1 : 0 };
  } catch (error) {
    return { part, when, chars: null, why: reasonOf(error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The size of each start hook's text, measured by calling the hook's own function (nothing it returns is kept or printed).
 * @param {{ part: string, when: 'main' | 'agent', file: string, measure: (hook: object) => unknown }[]} [parts] - tests pass others.
 * @param {number} [timeoutMs] - how long one part may take.
 * @returns {Promise<{ part: string, when: 'main' | 'agent', chars: number | null, why?: string }[]>} chars null: not counted, `why` says why.
 */
export async function hookTextParts(parts = HOOK_PARTS, timeoutMs = PART_TIMEOUT_MS) {
  const out = [];
  for (const part of parts) out.push(await measurePart(part, timeoutMs)); // one at a time, like hooks that each own a process
  return out;
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
    'start hooks that print only when they find something (resume-notice.mjs, git-tidy-gate.mjs)',
  ],
  agent: [
    "the agent file's own text (start tokens per role: tools/token-view)",
    'the brief',
    "Claude Code's tool definitions",
    'plugin skills and MCP tools',
  ],
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
    const text = tryRead(join(projects, name, 'memory', 'MEMORY.md'));
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
    const t = tryRead(join(cwd, f));
    if (t) add('always-loaded', f, t);
  }
  const ug = tryRead(join(userRoot, 'CLAUDE.md'));
  if (ug) add('always-loaded', '~/.claude/CLAUDE.md', ug);
  for (const [scope, root] of roots) {
    const name = (p) => `${scope}:${p.slice(root.length + 1).replace(/\\/g, '/')}`;
    for (const p of walk(join(root, 'rules'), (x) => x.endsWith('.md'))) {
      const t = readFileSync(p, 'utf8');
      add('paths' in frontmatter(t) ? 'rule(paths)' : 'rule(ALWAYS)', name(p), t);
    }
    for (const p of walk(join(root, 'skills'), (x) => x.endsWith('SKILL.md') && !x.includes('synced'))) {
      const t = readFileSync(p, 'utf8');
      add('skill-listing', name(p), frontmatter(t).description ?? '');
      add('skill-body', name(p), t);
    }
    for (const p of walk(join(root, 'agents'), (x) => x.endsWith('.md'))) add('agent-listing', name(p), frontmatter(readFileSync(p, 'utf8')).description ?? '');
  }
  const mcp = tryRead(join(cwd, '.mcp.json'));
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
  // A hook function left running past its timeout must not hold the process open; the empty write flushes stdout first.
  process.stdout.write('', () => process.exit(0));
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

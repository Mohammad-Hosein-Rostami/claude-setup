// Prints approximate recurring token cost of the Claude config visible from cwd.
// ~tokens = bytes / 4. Read-only. A manual CLI (`node ~/.claude/hooks/token-audit.mjs`), not a hook event handler.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const rows = [];
const tok = (b) => Math.ceil(b / 4);
const add = (kind, path, text) =>
  rows.push({ kind, path, bytes: Buffer.byteLength(text), lines: text.split('\n').length });

const tryRead = (p) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

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

const userRoot = join(homedir(), '.claude');
const projectRoot = join(process.cwd(), '.claude');
const roots = [['user', userRoot], ...(projectRoot === userRoot ? [] : [['project', projectRoot]])]; // cwd=~ would count twice

for (const f of ['CLAUDE.md', 'AGENTS.md']) {
  const t = tryRead(join(process.cwd(), f));
  if (t) add('always-loaded', f, t);
}
const ug = tryRead(join(homedir(), '.claude', 'CLAUDE.md'));
if (ug) add('always-loaded', '~/.claude/CLAUDE.md', ug);

for (const [scope, root] of roots) {
  for (const p of walk(join(root, 'rules'), (x) => x.endsWith('.md'))) {
    const t = readFileSync(p, 'utf8');
    const scoped = 'paths' in frontmatter(t);
    add(scoped ? 'rule(paths)' : 'rule(ALWAYS)', `${scope}:${p.slice(root.length + 1)}`, t);
  }
  for (const p of walk(join(root, 'skills'), (x) => x.endsWith('SKILL.md') && !x.includes('synced'))) {
    const t = readFileSync(p, 'utf8');
    const d = frontmatter(t).description ?? '';
    add('skill-listing', `${scope}:${p.slice(root.length + 1).replace(/\\/g, '/')}`, d);
    rows.push({
      kind: 'skill-body',
      path: `${scope}:${p.slice(root.length + 1).replace(/\\/g, '/')}`,
      bytes: Buffer.byteLength(t),
      lines: t.split('\n').length,
    });
  }
  for (const p of walk(join(root, 'agents'), (x) => x.endsWith('.md'))) {
    const t = readFileSync(p, 'utf8');
    const d = frontmatter(t).description ?? '';
    add('agent-listing', `${scope}:${p.slice(root.length + 1)}`, d);
  }
}

const mcp = tryRead(join(process.cwd(), '.mcp.json'));
if (mcp) {
  let servers = [];
  try {
    servers = Object.keys(JSON.parse(mcp).mcpServers ?? {});
  } catch (error) {
    console.warn(`warning: .mcp.json unreadable, MCP cost not counted: ${error.message}`);
  }
  rows.push({ kind: 'mcp', path: servers.join(', '), bytes: servers.length * 400, lines: servers.length });
}

const sum = (k) => rows.filter((r) => r.kind === k).reduce((n, r) => n + r.bytes, 0);
console.log('Recurring (every session):');
for (const k of ['always-loaded', 'rule(ALWAYS)', 'skill-listing', 'agent-listing', 'mcp'])
  console.log(`  ${k.padEnd(15)} ~${String(tok(sum(k))).padStart(6)} tok`);
console.log('On demand: rule(paths) / skill-body load only when matched or invoked.\n');
console.log('Largest items:');
rows
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 15)
  .forEach((r) =>
    console.log(`  ${String(tok(r.bytes)).padStart(6)} tok  ${String(r.lines).padStart(4)}L  ${r.kind.padEnd(14)} ${r.path}`),
  );
const flags = rows.filter(
  (r) => (r.kind === 'always-loaded' && r.lines > 200) || r.kind === 'rule(ALWAYS)' || (r.kind === 'skill-body' && r.lines > 500),
);
if (flags.length) {
  console.log('\nFlags:');
  flags.forEach((r) => console.log(`  ! ${r.kind} ${r.path} (${r.lines} lines)`));
}

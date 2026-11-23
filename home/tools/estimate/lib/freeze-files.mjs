// `backtest.mjs --freeze`: reads real tables, their sessions' transcripts and (optionally) their store files, and writes the
// anonymized frozen copy (lib/freeze-data.mjs) as <out>/backtest-data/t<n>.json and the seed runs as <out>/seed-runs.json.
// Exports: freezeCommand(argv) -> exit code (0); throws UsageError (exit 2) on any usage, input or output problem.
// Usage: backtest.mjs --freeze <STATUS.md>=<session-id> [<STATUS.md>=<session-id> | --freeze ...] --out <dir>
//          [--store <STATUS.md>=<store table.json>] [--projects <dir>]
//   A STATUS.md named twice takes both sessions. --store gives the table's first-seen times (`added` of the estimate's
//   table/<id>.json, read from a copy: a copy of a STATUS.md has another table id); without it a row is first seen at its first stamp.
// Fail closed (lane lessons 1-3): a table with a parse problem, a session with no transcript, a store file that is not a table
// file, a store for a table not frozen, an `--out` whose backtest-data is not a real folder or holds other .json files, or a file
// over MAX_FROZEN_BYTES stops the run before anything is written. Inputs are read without following a link (status-file.mjs,
// plain-file.mjs); outputs go through a temp file renamed over the name (state-files.mjs), never written through a link.
// Invariants: reads transcripts with no activity index (stateDir null), so nothing is written but the frozen files; stdout names
// the tables and counts, never row text.
import { lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readPlainFile } from '../../../hooks/lib/plain-file.mjs';
import { isSessionId } from '../../../hooks/lib/session-store.mjs';
import { writeStateText } from '../../../hooks/lib/state-files.mjs';
import { readStatusFile } from '../../status/status-file.mjs';
import { activeRuns, sessionTranscripts } from './activity.mjs';
import { MAX_FROZEN_BYTES, freezeTables, frozenTableText, seedRunsText } from './freeze-data.mjs';
import { UsageError } from './from-files.mjs';
import { parseInstant, parseWorkItems } from './items.mjs';
import { AGENT_KINDS } from './kinds.mjs';

const DATA_FOLDER = 'backtest-data';
const SEED_RUNS_FILE = 'seed-runs.json';
// The estimate store's own cap (table-store.mjs MAX_TABLE_BYTES, 16 MiB, not exported): a file its writer keeps is never refused here.
const MAX_STORE_BYTES = 16 << 20;
const STORE_VERSION = 2;
const CASE_FOLDING = ['darwin', 'win32']; // APFS and NTFS ignore case, so a path key does too
const USAGE = 'usage: backtest.mjs --freeze <STATUS.md>=<session-id> ... --out <dir> [--store <STATUS.md>=<table.json>] [--projects <dir>]';
const OPTIONS = { freeze: { type: 'string', multiple: true }, out: { type: 'string' }, store: { type: 'string', multiple: true }, projects: { type: 'string' } };

/** The real path of an input file, case-folded where the file system ignores case: one key for every spelling of one file. */
function pathKey(path) {
  let real;
  try {
    real = realpathSync.native(path);
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${error.message}`);
  }
  return CASE_FOLDING.includes(process.platform) ? real.toLowerCase() : real;
}

/** Splits `<left>=<right>` at the last `=`; throws the usage line naming `what` when a side is empty. */
function pairOf(spec, what) {
  const at = spec.lastIndexOf('=');
  if (at < 1 || at === spec.length - 1) throw new UsageError(`"${spec}" is not ${what}\n${USAGE}`);
  return [spec.slice(0, at), spec.slice(at + 1)];
}

/** The tables to freeze in the order first named, each with its sessions and its store file (or null). */
function tablesToFreeze(specs, storeSpecs) {
  const tables = new Map();
  for (const spec of specs) {
    const [statusPath, sessionId] = pairOf(spec, '<STATUS.md>=<session-id>');
    if (!isSessionId(sessionId)) throw new UsageError(`"${spec}" is not <STATUS.md>=<session-id>\n${USAGE}`);
    const key = pathKey(statusPath);
    if (!tables.has(key)) tables.set(key, { statusPath: resolve(statusPath), sessions: [], storePath: null });
    if (!tables.get(key).sessions.includes(sessionId)) tables.get(key).sessions.push(sessionId);
  }
  for (const spec of storeSpecs) {
    const [statusPath, storePath] = pairOf(spec, '<STATUS.md>=<table.json>');
    const table = tables.get(pathKey(statusPath));
    if (table === undefined) throw new UsageError(`--store "${spec}": ${statusPath} is not a table given to --freeze`);
    if (table.storePath !== null) throw new UsageError(`--store: ${statusPath} has two store files`);
    table.storePath = resolve(storePath);
  }
  return [...tables.values()];
}

function readOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (error) {
    throw new UsageError(`${error.message}\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const specs = [...(values.freeze ?? []), ...positionals];
  if (specs.length === 0 || values.out === undefined) throw new UsageError(USAGE);
  return {
    tables: tablesToFreeze(specs, values.store ?? []),
    outDir: resolve(values.out),
    projectsDir: values.projects ?? join(userInfo().homedir, '.claude', 'projects'), // not $HOME, which a project file can set
  };
}

/** The store file's first-seen map, checked: a table file of version 2 whose `added` maps row ids to real instants. */
function storeAdded(storePath) {
  let value;
  try {
    value = JSON.parse(readPlainFile(storePath, MAX_STORE_BYTES));
  } catch (error) {
    throw new UsageError(`--store ${storePath}: not readable as JSON within ${MAX_STORE_BYTES} bytes: ${error.message}`);
  }
  const added = value?.added;
  const isMap = added !== null && typeof added === 'object' && !Array.isArray(added);
  if (value?.v !== STORE_VERSION || !isMap || !Object.values(added).every((at) => typeof at === 'string' && parseInstant(at) !== null)) {
    throw new UsageError(`--store ${storePath}: not an estimate table file (v ${STORE_VERSION} with an \`added\` map of instants)`);
  }
  return added;
}

function loadTable({ statusPath, sessions, storePath }, projectsDir) {
  let read;
  try {
    read = readStatusFile(statusPath);
  } catch (error) {
    throw new UsageError(`cannot read ${statusPath}: ${error.message}`);
  }
  if (read.refused !== undefined) throw new UsageError(`${statusPath} ${read.refused}`);
  const { items, problems } = parseWorkItems(read.text);
  if (problems.length > 0) throw new UsageError(`${statusPath}: line ${problems[0].line}: ${problems[0].reason}`);
  const missing = sessions.find((sessionId) => sessionTranscripts(projectsDir, sessionId).length === 0);
  if (missing !== undefined) throw new UsageError(`no transcript of session ${missing} under ${projectsDir}`);
  const runs = activeRuns(sessions, { projectsDir, stateDir: null });
  return { statusPath, items, runs, added: storePath === null ? {} : storeAdded(storePath), fromStore: storePath !== null };
}

/** <out>/backtest-data as a real folder (made when missing) holding no .json file this run does not write. */
function dataFolder(outDir, names) {
  const out = lstatOrNull(outDir);
  if (out === null || !out.isDirectory()) throw new UsageError(`--out ${outDir} is not a folder`);
  const dir = join(outDir, DATA_FOLDER);
  if (lstatOrNull(dir) === null) mkdirSync(dir);
  if (!lstatSync(dir).isDirectory()) throw new UsageError(`${dir} is not a real folder (a link or a file)`);
  const stale = readdirSync(dir).filter((name) => name.endsWith('.json') && !names.includes(name));
  if (stale.length > 0) throw new UsageError(`${dir} holds ${stale.join(', ')}, which this freeze does not write: remove them or use another --out`);
  return dir;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** The file texts, each checked against MAX_FROZEN_BYTES before any is written. */
function checkedSize(name, text) {
  if (Buffer.byteLength(text) > MAX_FROZEN_BYTES) throw new UsageError(`${name} would be over ${MAX_FROZEN_BYTES} bytes; nothing written`);
  return { name, text };
}

const countBy = (rows) => AGENT_KINDS.map((kind) => [kind, rows.filter((row) => row.k === kind).length]).filter(([, count]) => count > 0);

function summaryLines(loaded, frozen, seedRows, outDir) {
  const lines = [`Froze ${frozen.length} table(s) into ${join(outDir, DATA_FOLDER)} and the seed runs into ${join(outDir, SEED_RUNS_FILE)}:`];
  frozen.forEach((table, at) => {
    const done = table.rows.filter((row) => row.doneMin !== null).length;
    const seen = loaded[at].fromStore ? 'first seen from the store' : 'first seen at the first stamp (no --store)';
    lines.push(`  ${table.table} = ${loaded[at].statusPath}: ${table.rows.length} rows (${done} done), ${table.active.length} active runs, ${seen}`);
  });
  if (seedRows.length === 0) lines.push(`${SEED_RUNS_FILE}: no finished agent row with a run of 1-240 working minutes, so it holds no runs`);
  else lines.push(`${SEED_RUNS_FILE}: ${seedRows.length} runs (${countBy(seedRows).map(([kind, count]) => `${kind} ${count}`).join(', ')})`);
  return lines;
}

/**
 * Runs `--freeze` (see the header).
 * @param {string[]} argv the command's arguments
 * @returns {number} 0 once every file is written
 * @throws {UsageError} on any usage, input or output problem, before anything is written
 */
export function freezeCommand(argv) {
  const options = readOptions(argv);
  const loaded = options.tables.map((table) => loadTable(table, options.projectsDir));
  const { tables, seedRows } = freezeTables(loaded);
  const files = tables.map((table) => checkedSize(`${table.table}.json`, frozenTableText(table)));
  const seed = checkedSize(SEED_RUNS_FILE, seedRunsText(seedRows));
  const dir = dataFolder(options.outDir, files.map((file) => file.name));
  for (const file of files) writeStateText(dir, file.name, file.text);
  writeStateText(options.outDir, seed.name, seed.text);
  process.stdout.write(`${summaryLines(loaded, tables, seedRows, options.outDir).join('\n')}\n`);
  return 0;
}

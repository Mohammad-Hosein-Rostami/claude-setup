// Synthetic STATUS.md tables, transcripts and seeds for the estimate tests. No real transcript text or table row.
// Exports: BASE_MS, HOUR_MS, MIN_MS, FIRST_ROW_LINE, SESSION, iso(hours), row(spec), statusDoc(rows), plainDoc(rows),
// writeTranscript(projectsDir, sessionId, fromH, toH), writeSeed(file, rows), seedRows(size, count, minutes).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const BASE_MS = Date.UTC(2026, 10, 10, 0, 0, 0);
export const HOUR_MS = 3_600_000;
export const MIN_MS = 60_000;
// The first table row sits on this 1-based line of a statusDoc().
export const FIRST_ROW_LINE = 7;
export const SESSION = '11111111-2222-4333-8444-555555555555';
const SEED_TABLE = 'f'.repeat(32); // a table id no table file has, so the seed rows always count

/** ISO 8601 UTC string `hours` after BASE_MS, minute precision (`2026-11-10T01:30Z`). */
export const iso = (hours) => new Date(BASE_MS + hours * HOUR_MS).toISOString().replace(':00.000Z', 'Z');

/** One table row with outer pipes; startedH/doneH are hours after BASE_MS or undefined for `-`; `raw` overrides a cell text. */
export function row({ id, item = `item ${id}`, size = 'S', startedH, doneH, evidence = 'abc1234', raw = {} }) {
  const cells = {
    started: startedH === undefined ? '-' : iso(startedH),
    done: doneH === undefined ? '-' : iso(doneH),
    ...raw,
  };
  return `| ${id} | ${item} | ${size} | ${cells.started} | ${cells.done} | ${evidence} |`;
}

/** A STATUS.md with the `## Work items` table (header on line 5, first row on FIRST_ROW_LINE). */
export function statusDoc(rows, trailer = '') {
  const head = ['# Status', '', '## Work items', '', '| id | item | size | started | done | evidence |', '| -- | ---- | ---- | ------- | ---- | -------- |'];
  return `${[...head, ...rows].join('\n')}\n${trailer}`;
}

/** The same table without outer pipes, the way status.mjs writes a table whose header has none (empty cells stay empty). */
export function plainDoc(rows) {
  const plain = (line) => line.replace(/^\| /, '').replace(/ \|$/, '').replace(/(?<=^|\| )-(?= \||$)/g, '');
  const head = ['# Status', '', '## Work items', '', 'id | item | size | started | done | evidence', '---|---|---|---|---|---'];
  return `${[...head, ...rows.map(plain)].join('\n')}\n`;
}

/** Writes a session transcript with one entry per minute from fromH to toH (hours after BASE_MS): continuous activity. */
export function writeTranscript(projectsDir, sessionId, fromH, toH) {
  const folder = join(projectsDir, '-synthetic-project');
  mkdirSync(folder, { recursive: true });
  const lines = [];
  for (let ms = BASE_MS + fromH * HOUR_MS; ms < BASE_MS + toH * HOUR_MS; ms += MIN_MS) lines.push(JSON.stringify({ type: 'assistant', timestamp: new Date(ms).toISOString() }));
  writeFileSync(join(folder, `${sessionId}.jsonl`), `${lines.join('\n')}\n`, { flag: 'a' });
}

/** `count` finished rows of one size, each costing `minutes`, done in the week before BASE_MS. */
export const seedRows = (size, count, minutes) => Array.from({ length: count }, (_, k) => ({ table: SEED_TABLE, size, kind: 'build', done: new Date(BASE_MS - (k + 1) * HOUR_MS).toISOString(), cost: minutes }));

/** Writes a version-2 seed file with the given rows and one finished job of `jobMinutes` with no growth. */
export function writeSeed(file, rows, jobMinutes = 600) {
  const jobs = [{ table: SEED_TABLE, at: new Date(BASE_MS - HOUR_MS).toISOString(), minutes: jobMinutes, growthNum: 0, growthDen: 1 }];
  writeFileSync(file, JSON.stringify({ v: 2, rows, jobs }));
}

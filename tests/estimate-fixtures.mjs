// Shared synthetic fixtures for the estimate tests: STATUS.md tables and transcript JSONL lines. No real transcript text.
// Exports: BASE_MS, FIRST_ROW_LINE, iso(hours), row(spec), statusDoc(rows), jsonl(entries), synthetic/assistant/resetNote entries.
export const BASE_MS = Date.UTC(2026, 10, 10, 0, 0, 0);
export const HOUR_MS = 3_600_000;
// The first table row sits on this 1-based line of a statusDoc().
export const FIRST_ROW_LINE = 7;

/** ISO 8601 UTC string `hours` after BASE_MS, minute precision (`2026-11-10T01:30Z`). */
export const iso = (hours) => new Date(BASE_MS + hours * HOUR_MS).toISOString().replace(':00.000Z', 'Z');

/** One table row; startedH/doneH are hours after BASE_MS or undefined for `-`; `item` is the item cell (a `close:` or `rework:`
 * prefix sets the row's kind); `raw` overrides a cell text. */
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

/** Five done S items of d = 1,1,2,2,3 hours (r = d), one after another with gaps, then `open` open rows. */
export function fiveDoneRows(openRows = []) {
  const durations = [1, 1, 2, 2, 3];
  let cursor = 0;
  const rows = durations.map((d, i) => {
    const r = row({ id: `D${i + 1}`, startedH: cursor, doneH: cursor + d });
    cursor += d + 1;
    return r;
  });
  return [...rows, ...openRows];
}

export const jsonl = (entries) => `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`;
export const synthetic = (hours, text) => ({ type: 'assistant', timestamp: new Date(BASE_MS + hours * HOUR_MS).toISOString(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] }, isApiErrorMessage: true });
export const assistant = (hours) => ({ type: 'assistant', timestamp: new Date(BASE_MS + hours * HOUR_MS).toISOString(), message: { model: 'claude-test', role: 'assistant', content: [{ type: 'text', text: 'ok' }] } });
export const userNote = (hours, text) => ({ type: 'user', timestamp: new Date(BASE_MS + hours * HOUR_MS).toISOString(), message: { role: 'user', content: text } });
export const LIMIT_TEXT = "You've hit your usage limit for this period.";
export const RESET_TEXT = 'Note: the usage limit has reset, continue.';

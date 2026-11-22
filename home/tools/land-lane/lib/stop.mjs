// Purpose: the refusal of a land-lane step: an exit code, a state word and the lines the caller prints. Nothing has landed when one is thrown.
// Exports: Stop, stop.
export class Stop extends Error {
  constructor(code, state, lines) {
    super(lines[0] ?? state);
    Object.assign(this, { code, state, lines });
  }
}

/** Throws a Stop: `code` is the exit code, `state` the word after `land: `, `lines` the text under it. */
export const stop = (code, state, ...lines) => { throw new Stop(code, state, lines); };

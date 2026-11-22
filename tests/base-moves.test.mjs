// Direct tests of moveVerdict (home/hooks/lib/base-moves.mjs): whether the branch moves in a reflog since a session's watch line are its own,
// only another session's, none, or not watched. Real reflog files in a temp folder; the context is built by hand (its `sources` field
// stands for the other sessions' claims, so no call-window store is needed). Every doubt must come out `own`.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { moveVerdict } from '../home/hooks/lib/base-moves.mjs';
import { reflogRealPath } from '../home/hooks/lib/call-windows.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const SHA = { a: 'a'.repeat(40), b: 'b'.repeat(40), c: 'c'.repeat(40), d: 'd'.repeat(40) };
const WATCH_KEY = 'k1';
const OTHER_KEY = 'k9';
const FAR_FUTURE_MS = () => Date.now() + 60_000;
const entry = (from, to) => `${from} ${to} Tester <t@example.com> 1700000000 +0000\tcommit: ${to.slice(0, 7)}\n`;

/** A reflog holding the given moves ([from, to] pairs); the session's watch stands after the first `watched` of them. */
function setup(moves, watched) {
  const reflog = join(makeTempDir('base-moves-'), 'main');
  writeFileSync(reflog, moves.map(([from, to]) => entry(from, to)).join(''));
  const real = reflogRealPath(reflog);
  const bytes = moves.slice(0, watched).reduce((sum, [from, to]) => sum + entry(from, to).length, 0);
  const tip = watched === 0 ? moves[0][0] : moves[watched - 1][1];
  const watch = { reflog: real, k: WATCH_KEY, bytes, tip, at: 1, settled: true };
  const log = { missing: false, usable: true, watches: [watch], lines: [], windows: [], firstAt: 1 };
  return { reflog, real, bytes, watch, ctx: { log, deadlineMs: FAR_FUTURE_MS(), agent: null, sources: [] } };
}

const MOVES = [[SHA.a, SHA.b], [SHA.b, SHA.c]];

test('a log that is missing or has no watch line of this reflog is unwatched', () => {
  const missing = setup(MOVES, 1);
  missing.ctx.log.missing = true;
  assert.equal(moveVerdict(missing.reflog, SHA.c, missing.ctx).verdict, 'unwatched');
  const other = setup(MOVES, 1);
  other.ctx.log.watches = [{ ...other.watch, reflog: join(other.real, 'elsewhere') }];
  assert.equal(moveVerdict(other.reflog, SHA.c, other.ctx).verdict, 'unwatched');
});

test('no move after the watch line is none, and the watch is returned', () => {
  const s = setup(MOVES, 2);
  const result = moveVerdict(s.reflog, SHA.c, s.ctx);
  assert.equal(result.verdict, 'none');
  assert.equal(result.watch, s.watch);
});

test('a move that no other session claims is own (the session\'s, or nobody\'s)', () => {
  const s = setup(MOVES, 1);
  s.ctx.transcriptPath = join(makeTempDir('base-moves-transcript-'), 'transcript.jsonl');
  writeFileSync(s.ctx.transcriptPath, '');
  assert.equal(moveVerdict(s.reflog, SHA.c, s.ctx).verdict, 'own');
});

test('a move inside an own program window is own even when another session\'s window covers it', () => {
  const s = setup(MOVES, 1);
  s.ctx.transcriptPath = join(makeTempDir('base-moves-transcript-'), 'transcript.jsonl');
  writeFileSync(s.ctx.transcriptPath, '');
  s.ctx.sources = [{ watches: [{ reflog: s.real, k: OTHER_KEY }], windows: [{ edge: true, openB: { [OTHER_KEY]: 0 }, closeB: { [OTHER_KEY]: 1e9 } }] }];
  s.ctx.log.windows = [{ kind: 'program', agent: null, closeAt: 2, openB: { [WATCH_KEY]: s.bytes }, closeB: { [WATCH_KEY]: 1e9 } }];
  assert.equal(moveVerdict(s.reflog, SHA.c, s.ctx).verdict, 'own');
});

test('a move that only an older session\'s closed window claims is foreign', () => {
  const s = setup(MOVES, 1);
  s.ctx.transcriptPath = join(makeTempDir('base-moves-transcript-'), 'transcript.jsonl');
  writeFileSync(s.ctx.transcriptPath, '');
  s.ctx.sources = [{ watches: [{ reflog: s.real, k: OTHER_KEY }], windows: [{ edge: true, openB: { [OTHER_KEY]: 0 }, closeB: { [OTHER_KEY]: 1e9 } }] }];
  assert.equal(moveVerdict(s.reflog, SHA.c, s.ctx).verdict, 'foreign');
});

test('every doubt is own: an unusable log, a tip that is not where the reflog ends, a broken chain, a missing transcript, a passed deadline, a missing reflog', () => {
  const claimed = () => [{ watches: [], windows: [] }];
  const unusable = setup(MOVES, 1);
  unusable.ctx.log.usable = false;
  assert.equal(moveVerdict(unusable.reflog, SHA.c, unusable.ctx).verdict, 'own', 'unusable log');

  const wrongTip = setup(MOVES, 1);
  assert.equal(moveVerdict(wrongTip.reflog, SHA.d, wrongTip.ctx).verdict, 'own', 'the branch is not where the reflog ends');

  const broken = setup([[SHA.a, SHA.b], [SHA.d, SHA.c]], 1);
  assert.equal(moveVerdict(broken.reflog, SHA.c, broken.ctx).verdict, 'own', 'a line whose old sha is not the one before');

  const noTranscript = setup(MOVES, 1);
  noTranscript.ctx.sources = claimed();
  assert.equal(moveVerdict(noTranscript.reflog, SHA.c, noTranscript.ctx).verdict, 'own', 'no transcript to cross-check the tool calls');

  const late = setup(MOVES, 1);
  late.ctx.deadlineMs = Date.now() - 1;
  assert.equal(moveVerdict(late.reflog, SHA.c, late.ctx).verdict, 'own', 'the verdict deadline passed');

  const gone = setup(MOVES, 1);
  assert.equal(moveVerdict(join(gone.reflog, 'nope'), SHA.c, gone.ctx).verdict, 'unwatched', 'a path that is no watched reflog');
});

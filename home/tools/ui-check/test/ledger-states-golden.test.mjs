// Purpose: golden test of the pixel path of the round ledger (lib/ledger.mjs): the `states` rows, the comparator, compareRounds,
// compareReference, their text tables and the batch exit code, on a fixed fixture, must equal the output taken from BASE 388ed5e4 when this
// test was added. Any change to that output is a change to the pixel gate and fails here. Exports: none. Browser-free.
// Invariant: EXPECTED is never regenerated to make a change pass; a deliberate pixel-path change needs its own decision and review.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { exitCodeFor } from '../lib/batch-records.mjs';
import { buildLedger, compareReference, compareRounds, formatReference, formatRounds } from '../lib/ledger.mjs';

const RENDERER = { platform: 'darwin-arm64', chromium: '151.0.7922.34' };

/** Capture files with fixed bytes, so each sha256 is the same on every machine (stateRow hashes bytes, it never decodes them). */
function writeCaptures(dir) {
  const file = (name, text) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, text);
    return target;
  };
  return { a: file('a.png', 'capture a'), b: file('b.png', 'capture b'), c: file('c.png', 'capture c'), d: file('d.png', 'capture d'), e: file('e.png', 'capture e'), missing: path.join(dir, 'absent.png') };
}

const element = (name) => ({ check: 'element', element: name, detail: 'width: is 10, should be 12 (delta 2)' });
const pixel = { check: 'pixel', element: '#card', detail: '0.900% of pixels differ', region: { x: 0, y: 0, w: 4, h: 4 }, percent: 0.9 };

/** Compare, responsive, diagnostic and capture-less records: only compare records with a capture on disk become state rows. */
function fixtureRecords(files) {
  const compare = (fields) => ({ part: 'compare', findings: [], status: 'pass', diffPixels: 0, driftPixels: 0, scale: 2, ...fields });
  return [
    compare({ surface: 'card', state: 'default', locale: undefined, width: 375, images: { actual: files.a } }),
    compare({ surface: 'card', state: 'hover', locale: 'fa', width: 375, status: 'fail', findings: [element('title'), element('icon'), pixel], diffPixels: 120, driftPixels: 30, images: { actual: files.b } }),
    compare({ surface: 'card', state: 'stuck', locale: 'en', width: 1440, status: 'fail', findings: [element('title')], diffPixels: 40, driftPixels: 5, images: { actual: files.c } }),
    compare({ surface: 'list', state: 'empty', locale: 'en', width: 1440, scale: undefined, diffPixels: undefined, driftPixels: undefined, images: { actual: files.d } }),
    compare({ surface: 'list', state: 'full', locale: 'en', width: 1440, diffPixels: 3, driftPixels: 1, images: { actual: files.e } }),
    compare({ surface: 'list', state: 'gone', locale: 'en', width: 1440, images: { actual: files.missing } }),
    compare({ surface: 'list', state: 'no-images', locale: 'en', width: 1440, images: null }),
    compare({ surface: 'list', state: 'cause', locale: 'en', width: 1440, diagnostic: true, images: { actual: files.a } }),
    { part: 'responsive', surface: 'card', state: 'default', locale: undefined, width: 320, status: 'pass', findings: [] },
  ];
}

/** The previous round: card/default unchanged, card/hover had more pixels, card/stuck had the same counts and one no-gain round already. */
function previousLedger(current) {
  const by = new Map(current.states.map((row) => [row.key, row]));
  const hover = by.get('card / hover / fa @375');
  const stuck = by.get('card / stuck / en @1440');
  return {
    states: [
      { ...by.get('card / default / default @375') },
      { ...hover, sha256: 'older', pixels: 300, drift: 60, rows: 2 },
      { ...stuck, sha256: stuck.sha256, noGainRounds: 1 },
    ],
  };
}

/** The reference run: one state worse now, one better, one with another pixel ratio, one equal (other bytes, same counts), one the run no longer has. */
function referenceLedger(current) {
  const by = new Map(current.states.map((row) => [row.key, row]));
  return {
    comparator: current.comparator,
    renderer: RENDERER,
    states: [
      { ...by.get('card / default / default @375') },
      { ...by.get('card / hover / fa @375'), sha256: 'ref-b', pixels: 10, drift: 0, rows: 0 },
      { ...by.get('card / stuck / en @1440'), sha256: 'ref-c', pixels: 90, drift: 10, rows: 1 },
      { ...by.get('list / empty / en @1440'), sha256: 'ref-d', scale: 1 },
      { ...by.get('list / full / en @1440'), sha256: 'ref-f' },
      { key: 'list / removed / en @1440', pixels: 7, scale: 2, sha256: 'ref-e' },
    ],
  };
}

function goldenOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-test-ledger-golden-'));
  try {
    const records = fixtureRecords(writeCaptures(dir));
    const ledger = buildLedger(records, { renderer: RENDERER, step: 'polish.s1', rule: 'default', conditions: null, head: 'abc123' });
    // The fields a BASE ledger has, picked by name: fields a later change adds beside them are not the pixel path and are tested elsewhere.
    const { comparator, renderer, step, rule, conditions, head, createdAt, states } = ledger;
    const stable = { comparator, renderer, step, rule, conditions, head, states };
    assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T/);
    const roundsLedger = structuredClone(ledger);
    const rounds = compareRounds(roundsLedger, previousLedger(ledger));
    const reference = compareReference(ledger, referenceLedger(ledger));
    const otherComparator = compareReference(ledger, { ...referenceLedger(ledger), comparator: { name: 'odiff', version: '0.0.1', options: {} } });
    const otherRenderer = compareReference(ledger, { ...referenceLedger(ledger), renderer: { platform: 'linux-x64', chromium: '120.0' } });
    return {
      ledger: stable,
      roundsStates: roundsLedger.states,
      rounds,
      roundsText: formatRounds(rounds),
      reference,
      referenceText: formatReference(reference),
      otherComparatorText: formatReference({ ...otherComparator, mismatch: otherComparator.mismatch.replace(/this run .*?;/, 'this run <current>;') }),
      otherRenderer,
      exitCodes: [exitCodeFor(records), exitCodeFor(records.filter((r) => r.status === 'pass')), exitCodeFor([]), exitCodeFor(records.filter((r) => r.diagnostic))],
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const EXPECTED = {
  "ledger": {
    "renderer": {
      "platform": "darwin-arm64",
      "chromium": "151.0.7922.34"
    },
    "step": "polish.s1",
    "rule": "default",
    "conditions": null,
    "head": "abc123",
    "states": [
      {
        "key": "card / default / default @375",
        "surface": "card",
        "state": "default",
        "width": 375,
        "scale": 2,
        "sha256": "9ae6f0fc449c98b4ceb4eee89154366c5d1d4e29fcd3140c24e40420f45ab5d9",
        "pixels": 0,
        "drift": 0,
        "rows": 0,
        "status": "pass"
      },
      {
        "key": "card / hover / fa @375",
        "surface": "card",
        "state": "hover",
        "locale": "fa",
        "width": 375,
        "scale": 2,
        "sha256": "e2c048ff7c87e433158b16f71c463dcf77285e042ae17b6e90f425a93ca0509e",
        "pixels": 120,
        "drift": 30,
        "rows": 2,
        "status": "fail"
      },
      {
        "key": "card / stuck / en @1440",
        "surface": "card",
        "state": "stuck",
        "locale": "en",
        "width": 1440,
        "scale": 2,
        "sha256": "1743d604c5643dabcb9a6ce0ef8a0bc02a5dd144115de1dae6cd870b605a42b3",
        "pixels": 40,
        "drift": 5,
        "rows": 1,
        "status": "fail"
      },
      {
        "key": "list / empty / en @1440",
        "surface": "list",
        "state": "empty",
        "locale": "en",
        "width": 1440,
        "scale": null,
        "sha256": "35880b1b5f3311c211260699a48b33ea124c1cf3b6adac83a0fe31b08db4629a",
        "pixels": 0,
        "drift": 0,
        "rows": 0,
        "status": "pass"
      },
      {
        "key": "list / full / en @1440",
        "surface": "list",
        "state": "full",
        "locale": "en",
        "width": 1440,
        "scale": 2,
        "sha256": "a038ac1ad428342b4620a8942bd3dc6f33e47a79d89a984274a068962f1b1886",
        "pixels": 3,
        "drift": 1,
        "rows": 0,
        "status": "pass"
      }
    ]
  },
  "roundsStates": [
    {
      "key": "card / default / default @375",
      "surface": "card",
      "state": "default",
      "width": 375,
      "scale": 2,
      "sha256": "9ae6f0fc449c98b4ceb4eee89154366c5d1d4e29fcd3140c24e40420f45ab5d9",
      "pixels": 0,
      "drift": 0,
      "rows": 0,
      "status": "pass",
      "noGainRounds": 0
    },
    {
      "key": "card / hover / fa @375",
      "surface": "card",
      "state": "hover",
      "locale": "fa",
      "width": 375,
      "scale": 2,
      "sha256": "e2c048ff7c87e433158b16f71c463dcf77285e042ae17b6e90f425a93ca0509e",
      "pixels": 120,
      "drift": 30,
      "rows": 2,
      "status": "fail",
      "noGainRounds": 0
    },
    {
      "key": "card / stuck / en @1440",
      "surface": "card",
      "state": "stuck",
      "locale": "en",
      "width": 1440,
      "scale": 2,
      "sha256": "1743d604c5643dabcb9a6ce0ef8a0bc02a5dd144115de1dae6cd870b605a42b3",
      "pixels": 40,
      "drift": 5,
      "rows": 1,
      "status": "fail",
      "noGainRounds": 2
    },
    {
      "key": "list / empty / en @1440",
      "surface": "list",
      "state": "empty",
      "locale": "en",
      "width": 1440,
      "scale": null,
      "sha256": "35880b1b5f3311c211260699a48b33ea124c1cf3b6adac83a0fe31b08db4629a",
      "pixels": 0,
      "drift": 0,
      "rows": 0,
      "status": "pass"
    },
    {
      "key": "list / full / en @1440",
      "surface": "list",
      "state": "full",
      "locale": "en",
      "width": 1440,
      "scale": 2,
      "sha256": "a038ac1ad428342b4620a8942bd3dc6f33e47a79d89a984274a068962f1b1886",
      "pixels": 3,
      "drift": 1,
      "rows": 0,
      "status": "pass"
    }
  ],
  "rounds": [
    {
      "key": "card / default / default @375",
      "verdict": "identical",
      "pixelDelta": 0,
      "rowDelta": 0,
      "plateau": false
    },
    {
      "key": "card / hover / fa @375",
      "verdict": "gain",
      "pixelDelta": -180,
      "rowDelta": 0,
      "plateau": false
    },
    {
      "key": "card / stuck / en @1440",
      "verdict": "identical, no-gain",
      "pixelDelta": 0,
      "rowDelta": 0,
      "plateau": true
    },
    {
      "key": "list / empty / en @1440",
      "verdict": "new",
      "pixelDelta": null,
      "rowDelta": null,
      "plateau": false
    },
    {
      "key": "list / full / en @1440",
      "verdict": "new",
      "pixelDelta": null,
      "rowDelta": null,
      "plateau": false
    }
  ],
  "roundsText": [
    "  card / default / default @375: identical (pixels 0, rows 0)",
    "  card / hover / fa @375: gain (pixels -180, rows 0)",
    "  card / stuck / en @1440: identical, no-gain PLATEAU (pixels 0, rows 0)",
    "  list / empty / en @1440: new (pixels -, rows -)",
    "  list / full / en @1440: new (pixels -, rows -)"
  ],
  "reference": {
    "ok": false,
    "mismatch": null,
    "rows": [
      {
        "key": "card / default / default @375",
        "verdict": "identical",
        "pixels": 0,
        "refPixels": 0
      },
      {
        "key": "card / hover / fa @375",
        "verdict": "worse",
        "pixels": 120,
        "refPixels": 10
      },
      {
        "key": "card / stuck / en @1440",
        "verdict": "better",
        "pixels": 40,
        "refPixels": 90
      },
      {
        "key": "list / empty / en @1440",
        "verdict": "different-pixel-ratio",
        "pixels": 0,
        "refPixels": 0
      },
      {
        "key": "list / full / en @1440",
        "verdict": "equal",
        "pixels": 3,
        "refPixels": 3
      },
      {
        "key": "list / removed / en @1440",
        "verdict": "missing",
        "pixels": null,
        "refPixels": 7
      }
    ]
  },
  "referenceText": [
    "no-worse: FAIL - 3 worse: card / hover / fa @375; list / empty / en @1440; list / removed / en @1440",
    "  card / default / default @375: identical (0 -> 0 px)",
    "  card / hover / fa @375: worse (10 -> 120 px)",
    "  card / stuck / en @1440: better (90 -> 40 px)",
    "  list / empty / en @1440: different-pixel-ratio (0 -> 0 px)",
    "  list / full / en @1440: equal (3 -> 3 px)",
    "  list / removed / en @1440: missing (7 -> - px)"
  ],
  "otherComparatorText": [
    "no-worse: FAIL - different comparator: reference {\"name\":\"odiff\",\"version\":\"0.0.1\",\"options\":{}}, this run <current>; take a new reference on the base tip (never on the lane tip)"
  ],
  "otherRenderer": {
    "ok": false,
    "mismatch": "different renderer: reference linux-x64 Chromium 120.0, this run darwin-arm64 Chromium 151.0.7922.34; take a new reference on the base tip (never on the lane tip)",
    "rows": []
  },
  "exitCodes": [
    1,
    0,
    1,
    1
  ]
};

test('the pixel path (states, comparator, compareRounds, compareReference, exit code) equals the output taken from BASE', () => {
  const actual = JSON.parse(JSON.stringify(goldenOutput()));
  const { comparator, ...rest } = actual.ledger;
  assert.equal(comparator.name, 'odiff');
  assert.deepEqual(comparator.options, { threshold: 0.1, antialiasing: true });
  assert.match(comparator.version, /^\d+\.\d+\.\d+/);
  assert.deepEqual({ ...actual, ledger: rest }, EXPECTED);
});

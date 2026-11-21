// Purpose: `attribute` (P4) - where each compare's leftover pixels come from: every colour-metric pixel (any channel > 2, anti-aliasing
// counted) goes to the topmost Figma node and a class (accepted, text anti-aliasing, flagged text, graphic, other), with crops
// baseline | actual | diff per cluster. Exports: options, run.
// Exit 0 when no record fails under its rule / 1 otherwise / 2 usage or setup error: no results.json, no compare record with images,
// a missing image or cache, or a recount that differs from the record's driftPixels.
// Invariants: reads results.json and the captures, changes no capture and no record; writes <results>/attribution.json and the crops
// in each state's attribution/ folder. The rule is the record's (`rule: strict`) or `--strict`; logic lives in lib/attribution*.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { parse, need } from '../lib/args.mjs';
import { acceptanceContext, attributeRecords, formatAttribution, writeAttribution } from '../lib/attribution-records.mjs';
import { UsageError } from '../lib/errors.mjs';

export const options = {
  results: { type: 'string' }, // a batch or run --out folder holding results.json
  accepted: { type: 'string' }, // the coverage matrix whose accepted entries (owner decision + reason) may accept pixels
  strict: { type: 'boolean', default: false }, // judge every record under the strict rule (P3f)
};

/** The records of <dir>/results.json. @throws {UsageError} when it is missing or not a JSON array */
function readResults(dir) {
  const file = path.join(dir, 'results.json');
  let records;
  try {
    records = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`--results ${dir}: cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(records)) throw new UsageError(`${file} is not a results list (a JSON array of records)`);
  return records;
}

/** Run attribute. @param {string[]} argv @returns {Promise<number>} exit code */
export async function run(argv) {
  const values = parse(argv, options);
  need(values, 'results');
  const dir = path.resolve(values.results);
  const acceptance = acceptanceContext(values.accepted === undefined ? undefined : path.resolve(values.accepted));
  const results = attributeRecords(readResults(dir), { strict: values.strict, acceptance });
  if (results.length === 0) throw new UsageError(`${dir}/results.json has no compare record with images to attribute`);
  const file = writeAttribution(dir, results);
  const failed = results.filter((r) => !r.pass).length;
  console.log([...formatAttribution(results), `result: ${failed === 0 ? 'PASS' : 'FAIL'} attribute - ${results.length} records, ${failed} failing - ${file}`].join('\n'));
  return failed === 0 ? 0 : 1;
}

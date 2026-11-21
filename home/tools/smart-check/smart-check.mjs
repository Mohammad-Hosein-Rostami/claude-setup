// Purpose: the one command of the smart check (spec r9-smart-check): `smart-check <sub>` hands each sub-command to its module.
// Usage: node smart-check.mjs plan [plan.mjs flags]          the plan of the current change, nothing run
//        node smart-check.mjs run [run.mjs flags]            pinned checks and each kind at its level, with the report
//        node smart-check.mjs background [--seconds <n>]     the queued skipped checks; their result becomes truth (run it when idle,
//                                                            with run_in_background)
//        node smart-check.mjs stats [--json] [--doctor]      miss rate per kind and overall with the 95% bound
//        node smart-check.mjs truth|defect|train ...         ledger.mjs (labels, owner defects, the weekly retrain)
// Exports: none. Exit codes: those of the sub-command; 2 for an unknown one.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROUTES = { plan: ['plan.mjs'], run: ['run.mjs'], background: ['run.mjs', '--background'], stats: ['ledger.mjs', 'stats'], truth: ['ledger.mjs', 'truth'], defect: ['ledger.mjs', 'defect'], train: ['ledger.mjs', 'train'] };

const [sub, ...rest] = process.argv.slice(2);
const route = ROUTES[sub];
if (!route) {
  console.error(`usage: smart-check.mjs ${Object.keys(ROUTES).join('|')} [flags]`);
  process.exitCode = 2;
} else {
  const [file, ...fixed] = route;
  process.exitCode = spawnSync(process.execPath, [join(HERE, file), ...fixed, ...rest], { stdio: 'inherit' }).status ?? 1;
}

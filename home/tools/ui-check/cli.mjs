#!/usr/bin/env node
// Purpose: entry point for ui-check (figma-pull | figma-frames | compare | responsive | columns | batch).
// Exports: none. Exit codes: 0 pass, 1 check failed, 2 usage or setup error. Never prints FIGMA_TOKEN.
import { UsageError } from './lib/errors.mjs';

const COMMANDS = ['figma-pull', 'figma-frames', 'compare', 'responsive', 'columns', 'batch'];
const USAGE = `usage: ui-check <${COMMANDS.join('|')}> [flags]   (see README.md)`;

async function main(argv) {
  const [name, ...rest] = argv;
  if (!COMMANDS.includes(name)) throw new UsageError(USAGE);
  const command = await import(`./commands/${name}.mjs`);
  return command.run(rest);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Anything that is not a failed check (bad flags, missing setup, unreachable URL, API errors) is exit 2.
  console.error(`${error instanceof UsageError ? 'usage/setup error' : 'error'}: ${error.message}`);
  process.exitCode = 2;
}

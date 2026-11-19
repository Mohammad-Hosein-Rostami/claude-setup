// Preload for tests that need a hook to fail inside one of its own files: `node --import <this file> <hook>` with BREAK_AT set to a
// file name (`rm-paths.mjs`). From then on os.homedir() and JSON.stringify() throw whenever a function of that file is on the call stack,
// and work as usual everywhere else. Nothing in the hooks knows about this file: the failure is injected from outside, so the test proves
// what the shipped code does when one of its parts throws. Exports nothing.
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';

const breakAt = process.env.BREAK_AT;
const insideBrokenFile = () => breakAt !== undefined && breakAt !== '' && new Error('probe').stack.includes(breakAt);
const breaking = (real) => (...args) => {
  if (insideBrokenFile()) throw new Error(`injected failure in ${breakAt}`);
  return real(...args);
};

os.homedir = breaking(os.homedir);
JSON.stringify = breaking(JSON.stringify);
syncBuiltinESMExports(); // `import { homedir } from 'node:os'` in the hook now gets the wrapper

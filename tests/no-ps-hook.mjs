// An import hook for tests (not a test file): stands in for a machine where ps cannot tell a process start (Windows, Git Bash).
// It loads disk-free/lib/live-sessions.mjs as it is, except that processStarts returns an empty Map, as it does there.
// Usage: node --import <this file> ... (or `--import <file url>` in NODE_OPTIONS, so a whole process tree sees no ps).
import { registerHooks } from 'node:module';

const LIVE_SESSIONS = '/disk-free/lib/live-sessions.mjs';
const REAL_EXPORT = 'export function processStarts(';
const NO_START_EXPORT = 'export function processStarts(_pids) { return new Map(); }\nfunction realProcessStarts(';

registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.endsWith(LIVE_SESSIONS)) return loaded;
    const source = String(loaded.source);
    // A moved or renamed export must fail loudly: a hook that silently hides nothing would turn the tests that use it green.
    if (!source.includes(REAL_EXPORT)) throw new Error(`no-ps-hook: ${LIVE_SESSIONS} no longer has "${REAL_EXPORT}"`);
    return { ...loaded, source: source.replace(REAL_EXPORT, NO_START_EXPORT) };
  },
});

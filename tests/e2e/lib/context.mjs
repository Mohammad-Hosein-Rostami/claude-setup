// What a scenario's setup, run and check get: the run's shared state and the scenario's own context. Exports: quote(arg),
// commandLine(command, args, {cwd, env}), makeOps({dry, root, record}), makeRunState(spec), usesRealHome(run, scenario),
// makeContext(run, scenario).
// Why: one context serves both the dry run and the live run. Each operation (mkdir, write, link, copy, a command, a `claude -p`)
// is recorded as one printed step first; in a dry run nothing more happens (a command returns exit 0 and empty output, a claude
// run returns no events), so `--dry-run` prints the exact setup steps and command lines of every scenario and starts nothing.
// Invariants: a live write, link or copy is refused outside the run root (scratch.mjs assertInside); every claude argv comes from
// claudeArgs (models.mjs), so no run can start without an allowed `--model`; every child gets childEnv (env.mjs) with the
// scenario's own names only; each child's timeout is what is left of the scenario's wall-clock budget; once a usage limit is
// seen (run.limit), a run is refused its login (run.login, login.mjs) or the run is interrupted, no new child starts; the
// `--resume` rounds stop at the first run that ended with an error or no result. HOME: `--real-home` gives the real HOME
// (run.realPaths) only to a scenario that exports `needsRealHome = true` (E9); every other scenario keeps the temp HOME.
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LIMITS } from './checks.mjs';
import { runClaude } from './claude-run.mjs';
import { childEnv } from './env.mjs';
import { loginRefusal } from './login.mjs';
import { dialogCalls } from './logs.mjs';
import { claudeArgs } from './models.mjs';
import { assertInside } from './scratch.mjs';
import { runDetached, runQuick } from './spawn.mjs';

const PLAIN_ARG = /^[A-Za-z0-9_\-.,/:=@+%]+$/;
const MIN_CHILD_MS = 1_000;
const MS_PER_MINUTE = 60_000;

/** @returns {string} the argument as a POSIX shell word (printing only; nothing here runs a shell) */
export const quote = (arg) => (PLAIN_ARG.test(String(arg)) ? String(arg) : `'${String(arg).replace(/'/g, `'\\''`)}'`);

/** @returns {string} `NAME=value ... command args  (in <cwd>)`: the scenario's own env names, then the exact argv */
export function commandLine(command, args, { cwd, env = {} } = {}) {
  const names = Object.entries(env).map(([name, value]) => `${name}=${quote(value)} `).join('');
  return `${names}${[command, ...args].map(quote).join(' ')}${cwd ? `  (in ${cwd})` : ''}`;
}

/**
 * @param {{dry: boolean, root: string, record: (text: string) => void}} spec
 * @returns {{mkdir: Function, write: Function, symlink: Function, copy: Function}} the file operations of a scenario or the home
 */
export function makeOps({ dry, root, record }) {
  const inside = (path) => assertInside(path, root);
  return {
    mkdir(path) {
      record(`mkdir ${path}`);
      if (!dry) mkdirSync(inside(path), { recursive: true, mode: 0o700 });
    },
    write(path, text, { mode = 0o644, label = '' } = {}) {
      record(`write ${path}${label ? ` (${label})` : ''}`);
      if (dry) return;
      mkdirSync(dirname(inside(path)), { recursive: true, mode: 0o700 });
      writeFileSync(inside(path), text, { mode });
    },
    symlink(target, path, { mustExist = false } = {}) {
      record(`link ${path} -> ${target}`);
      if (dry) return;
      if (mustExist && !existsSync(target)) throw new Error(`e2e: ${target} is missing in the checkout under test`);
      symlinkSync(target, inside(path));
    },
    copy(from, to, { transform = (text) => text, note = '', missing = `e2e: ${from} is missing` } = {}) {
      record(`copy ${from} -> ${to}${note ? ` (${note})` : ''}`);
      if (dry) return;
      if (!existsSync(from)) throw new Error(missing);
      writeFileSync(inside(to), transform(readFileSync(from, 'utf8')), { mode: 0o600 });
    },
  };
}

/**
 * @param {{dry: boolean, root: string, setupFrom: string, realHome: string, realHomeMode: boolean, paths: object, realPaths?: object,
 *   childPath?: string, quietLog?: string, dialogLog?: string, dialogModeFile?: string,
 *   registry?: import('./processes.mjs').ProcessRegistry}} spec
 * @returns {object} the run's shared state: these fields, plus the stop switch, the limit seen and every session id of the run
 */
export function makeRunState(spec) {
  const controller = new AbortController();
  const run = {
    ...spec, controller, signal: controller.signal, limit: null, login: null, interrupted: false, sessionIds: new Set(), before: null,
    stopAtLimit(limit) {
      if (run.limit === null) run.limit = limit;
      controller.abort();
    },
    /** A claude run was refused its login: every later call would be too, so the whole run stops. */
    stopAtLogin(refusal) {
      if (run.login === null) run.login = refusal;
      controller.abort();
    },
    interrupt() {
      run.interrupted = true;
      controller.abort();
    },
    stopped: () => controller.signal.aborted,
  };
  return run;
}

/** @returns {boolean} true when the scenario gets the real HOME: `--real-home` and the scenario needs it (E9 only) */
export const usesRealHome = (run, scenario) => run.realHomeMode === true && scenario.needsRealHome === true && Boolean(run.realPaths);

/**
 * @param {ReturnType<typeof makeRunState>} run
 * @param {{id: string, minutes?: number, needsRealHome?: boolean}} scenario
 * @returns {object} the scenario's context (see the header)
 */
export function makeContext(run, scenario) {
  const dir = join(run.root, scenario.id);
  const deadlineMs = Date.now() + (scenario.minutes ?? LIMITS.defaultScenarioMinutes) * MS_PER_MINUTE;
  const steps = [];
  const realHomeMode = usesRealHome(run, scenario);
  const paths = realHomeMode ? run.realPaths : run.paths;
  const ctx = {
    id: scenario.id, dry: run.dry, run, dir, repo: join(dir, 'repo'), origin: join(dir, 'origin.git'), logs: join(dir, 'logs'),
    paths, setupFrom: run.setupFrom, realHome: run.realHome, realHomeMode,
    phase: 'setup', steps, sessions: [], notes: {}, timedOut: false, notRun: null, deadlineMs,
    record: (text, extra = {}) => steps.push({ phase: ctx.phase, text, ...extra }),
    tool: (...parts) => join(run.setupFrom, 'home', 'tools', ...parts),
    remainingMs: () => Math.max(MIN_CHILD_MS, deadlineMs - Date.now()),
    env: (extra = {}) => childEnv({ home: paths.home, tmp: paths.tmp, path: run.childPath, quietLog: run.quietLog,
      longRunState: paths.longRunState, extra }),
    skip(reason) {
      ctx.notRun = reason;
      ctx.record(`not run: ${reason}`);
    },
    exec(command, args, { cwd = ctx.repo, extra = {}, timeoutMs, input } = {}) {
      ctx.record(commandLine(command, args, { cwd, env: extra }));
      if (run.dry) return { code: 0, stdout: '', stderr: '' };
      if (run.stopped()) return { code: null, stdout: '', stderr: 'e2e: the run was stopped' };
      return runQuick(command, args, { cwd, env: ctx.env(extra), timeoutMs: Math.min(timeoutMs ?? Infinity, ctx.remainingMs()), input });
    },
    git: (args, options = {}) => ctx.exec('git', args, options),
    /** The scripted dialog's next answer (allow | deny | timeout) for every child started after this. */
    dialog(mode) {
      ctx.write(run.dialogModeFile ?? join(run.root, 'dialog-mode'), mode, { label: `scripted dialog: ${mode}` });
    },
    dialogCount: () => (run.dry ? 0 : dialogCalls(run.dialogLog).length),
    /** A long child (land, suite, long-run) started now; `done` settles when it ends. */
    background(name, command, args, { cwd = ctx.repo, extra = {} } = {}) {
      ctx.record(`${commandLine(command, args, { cwd, env: extra })}  &`);
      const outFile = join(ctx.logs, `${name}.out.log`);
      const errFile = join(ctx.logs, `${name}.err.log`);
      if (run.dry) return { done: Promise.resolve({ code: 0, signal: null, timedOut: false, stopped: false, durationMs: 0 }), outFile, errFile, pid: () => null };
      mkdirSync(ctx.logs, { recursive: true, mode: 0o700 });
      let pid = null;
      const done = runDetached({ command, args, env: ctx.env(extra), cwd, outFile, errFile, timeoutMs: ctx.remainingMs(),
        registry: run.registry, signal: run.signal, onSpawn: (spawned) => { pid = spawned; } });
      return { done, outFile, errFile, pid: () => pid };
    },
    /** One `claude -p` (see the header); `note` marks the printed line (E4's deny cases). */
    async claude({ name, prompt, model, cwd = ctx.repo, extra = {}, resume = null, note = '' }) {
      const args = claudeArgs({ prompt, model, resume });
      ctx.record(`${note ? `[${note}] ` : ''}${commandLine('claude', args, { cwd, env: extra })}`, { claudeArgs: args });
      const empty = { name, args, model, cwd, events: [], init: null, result: null, sessionId: null, limit: null, stderrTail: '' };
      if (run.dry) return pushed({ ...empty, dry: true, exit: { code: 0 } });
      if (run.stopped()) return pushed({ ...empty, exit: { code: null, stopped: true } });
      const session = await runClaude({ name, args, cwd, env: ctx.env(extra), dir: ctx.logs, timeoutMs: ctx.remainingMs(),
        registry: run.registry, signal: run.signal, onLimit: (limit) => run.stopAtLimit(limit) });
      if (session.exit.timedOut) ctx.timedOut = true;
      if (session.sessionId) run.sessionIds.add(session.sessionId);
      const refusal = loginRefusal(session);
      if (refusal !== null) run.stopAtLogin({ scenario: ctx.id, name, text: refusal });
      return pushed(session);
    },
    /**
     * A claude run, then `--resume <id> "continue"` rounds while `isDone(session)` is false (plan U2; at most maxResumeRounds).
     * A run that ended with an error result or none (a crash, a refusal) is not resumed: the loop stops there and says so.
     * @returns {Promise<{session: object, sessions: object[], rounds: number, mode: string, done: boolean}>}
     */
    async claudeUntil(spec, isDone) {
      let session = await ctx.claude(spec);
      const sessions = [session];
      if (run.dry) {
        ctx.record(`(while the job is not done: up to ${LIMITS.maxResumeRounds} rounds of claude --resume <session id> continue, same flags)`);
        return { session, sessions, rounds: 0, mode: 'dry run', done: false };
      }
      let rounds = 0;
      const id = () => session.sessionId ?? sessions[0].sessionId;
      const failed = () => session.result === null || session.result.is_error === true;
      while (!isDone(session) && !failed() && rounds < LIMITS.maxResumeRounds && id() && !run.stopped() && !ctx.timedOut) {
        rounds += 1;
        session = await ctx.claude({ ...spec, name: `${spec.name}-resume${rounds}`, prompt: 'continue', resume: id() });
        sessions.push(session);
      }
      const done = isDone(session);
      const ran = rounds === 0 ? 'one run' : `${rounds} resume round(s)`;
      return { session, sessions, rounds, mode: !done && failed() ? `${ran}, stopped: ${session.result ? 'an error result' : 'no result'}` : ran, done };
    },
  };
  const pushed = (session) => { ctx.sessions.push(session); return session; };
  Object.assign(ctx, makeOps({ dry: run.dry, root: run.root, record: ctx.record }));
  return ctx;
}

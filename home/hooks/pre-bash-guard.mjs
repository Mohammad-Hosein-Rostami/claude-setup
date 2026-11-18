// PreToolUse(Bash) guard. Reads the hook JSON from stdin, never evaluates the command.
// Exports: decide(command, {cwd, project, prodHosts}) -> {allow: true, advice?} | {allow: false, ask: true, reason, reasons, advice?};
// segments(command) -> string[][]. Parsing lives in lib/shell-words.mjs and lib/command-of.mjs.
// Nothing is denied for good. Every safety rule hit is an ASK, and the hook answers it with a timed native dialog (lib/timed-ask.mjs:
// Allow is the default, no answer in 2 min (CLAUDE_ASK_TIMEOUT_S) goes ahead as Allow, only a click on Deny denies); with no
// GUI (ssh, CI, no display) or a failing dialog it falls back to the CLI's own "ask" prompt, which also appears in
// bypassPermissions mode (verified on CLI 2.1.323). Bounce once (lib/bounce-once.mjs): when a reason can be fixed by rewriting the
// command (a variable command word, a risky word inside shell expansion, a literal secret), the first send is denied with the rewrite
// instead, naming by class (lib/reason-classes.mjs) any other reason that will still ask; the identical command sent again gets the ask
// above. ADVICE (quality rules: a hand-edited lockfile, a merge that can create a merge commit, a branch moved by update-ref, a copy of an existing lane branch, a fast-forward merge into the base without a suite PASS: lib/git-advice.mjs, a `for|while|until` loop that sleeps 5 s or more or a single sleep of 30 s or more: lib/wait-advice.mjs) never asks: alone,
// the first send is denied with the fix and the identical retry runs; next to an ask or bounce it is appended (table: lib/bounce-once.mjs) Every ask and its outcome is logged (lib/guard-log.mjs, no secrets).
// Rules. DESTRUCTIVE (the dialog says "DESTRUCTIVE: ..."): force push (incl. -fu clusters and +refspec), `push --mirror`,
// remote branch delete, rm -r outside the project (temp dirs allowed, `cd` tracked within one command line, `cd` to `~`,
// `$HOME` and `$(git rev-parse --show-toplevel)` (from inside the project only) is resolved, as are leading
// `~`/`$HOME`/`$TMPDIR`/`$CLAUDE_PROJECT_DIR` and variables assigned earlier in the line (the last assignment wins,
// `VAR=$(mktemp -d)` is the temp dir, `..` is resolved after substitution; an unknown variable asks for `rm -r` only; lib/rm-paths.mjs;
// $HOME, `/` and a drive root never count as the project), disk wipes (dd of=/dev/x, mkfs, wipefs, shred/blkdiscard on a device), rm -r run
// by xargs or parallel, also inside the `sh -c` script they run (its targets come from stdin; `xargs rm -f` is fine; lib/command-checks.mjs).
// Plain ASK: git --no-verify (and unique prefixes), `git -c core.hooksPath`, `HUSKY=0 git`, a literal secret in the
// command (lib/secrets.mjs; the text never repeats it), `git push` (not --dry-run), `gh release *`, `gh pr merge`, package
// publish (lib/outward.mjs), ssh/scp/rsync/psql/mysql that write to a production host (lib/remote.mjs; list in
// ~/.claude/private/prod-hosts), `security find-*-password -w|-g` / `dump-keychain` / `export` and `gh auth token` (print a stored secret),
// `gh ssh-key add` of a file that is not `*.pub`, and a private credential file (`.ssh/id_*` or any non-public file directly under `.ssh`,
// `.aws/credentials`, `.netrc`, gh `hosts.yml`, `.kube/config`, `.npmrc`, `.docker/config.json`, `.pypirc`) in one command line with a network sender or cloud upload
// (`aws s3 cp`, `gsutil cp`, `rclone copy` ...), a whole `~/.ssh` / `.aws` / `.gnupg` folder given to a sender or archived before one, or a
// credential fed to ssh's stdin, unless it is the value of an identity flag (`ssh|scp|sftp -i`, curl `--key`; lib/credential-send.mjs).
// A literal-secret ask that the owner allowed (or let time out) is remembered for the rest of the session as sha256 digests
// (lib/allowed-literals.mjs, lib/remembered-ask.mjs): the same values again run without a dialog (log outcome "remembered") only when
// the command is also clean with the values neutralised. An ask with any other reason always shows its dialog and remembers nothing.
// ALLOW + LOG: `sed -i`, heredoc and inline-interpreter writes to code files are allowed; their paths go to the edit log
// so the Stop typecheck gate covers them (lib/code-writes.mjs, lib/edit-log.mjs).
// Everything else (and any input it cannot parse) is allowed. Reading files, `.env` included, is never blocked.
//
// This is a safety net against model mistakes, not a sandbox. Invariants: it never executes the command, it fails open on
// its own errors, and it prefers a missed block over a false block of a normal dev command.
// Position independence: after the command word, every later word that is a dangerous verb (rm, git, dd, mkfs, gh, publish, ssh,
// psql, shells ...) is checked as a command too, so unknown wrappers (`ionice -c3 rm -rf /x`) need no list (lib/dangerous-scan.mjs);
// the scan is skipped after echo/grep/man/git/docker/ssh and similar. `$'\x72m'` ANSI-C words are decoded (lib/ansi-c.mjs); `eval` of a
// variable or substitution asks (lib/eval-check.mjs; `eval "$(ssh-agent -s)"` style tool init is silent); a variable command word asks.
// Handled: `& && || ; |` and newlines as separators; `( ) {` groups, `$(...)` and backticks (also inside double quotes) re-checked as commands;
// leading `! if then do else elif while until`; command matched by basename (`/bin/rm`, `\rm`) through wrappers command/builtin/env/sudo/doas/
// nohup/xargs/exec/nice/timeout/stdbuf/time/sshpass; `bash -c '...'` and every command git itself runs (lib/git-runs.mjs: `rebase -x`, `-c
// core.pager=`, GIT_SSH_COMMAND ...) are decided recursively; `git-<sub>` programs are git (lib/command-of.mjs); git-run variables are judged where assigned (lib/git-run-values.mjs).
// Two parsers, one rule set: the regex tokenizer (lib/shell-words.mjs) and an independent character-level lexer (lib/shell-lexer.mjs: quotes,
// comments, `$((..))`, `$(...)` inside double quotes, heredocs wherever they really start) both feed reasonsOf; `decide` merges them, and a
// reason only the lexer found ends with "(matched in raw text)". So `out="$(git push origin)"` and `git commit -m "see <<EOF"` + `git push -f`
// are caught whatever the quoting. Commands that hide what runs always ask (lib/shell-hazards.mjs): `| bash`, `bash <<EOF`, `sh -s`, a
// variable/`$(...)`/backtick as command word (`$X`; `$EDITOR` and an earlier one-word assignment are fine), `env -S`, `su -c`;
// `pnpm exec|dlx`, `yarn exec`, `npx` ... scan what they run (`npm run`/`pnpm run` do not). Brace expansion in rm paths is expanded
// (lib/braces.mjs), or asks when it cannot be listed. `git -c alias.*`, `gh api -X PUT|POST|PATCH|DELETE` on repo/merge/release paths,
// `gh repo delete`, `gh repo edit --visibility`, `gh secret set`, `gh workflow run`, a `gh api graphql` mutation, `diskutil erase*` and `apfs delete*`,
// `newfs_*`, `> /dev/disk*`, `cp|mv|tee ... /dev/disk*|sd*|nvme*`, an `alias` whose body would ask ask. PGHOST/PGSERVICE/MYSQL_HOST set earlier in the line count as the
// host of a later psql/mysql. Prod SQL with a `$tag$` quote, a backslash escape or `;` followed by more text is not read-only. Nesting deeper than MAX_NESTING asks.
// Fail to ask (Round 4, lib/raw-risk.mjs): the two parsers are not a security boundary. A command that has ANY hidden-execution construct
// (`$(`, backtick, `<<`, `<(`, eval, trap, case, `\r`, a pipe into a shell ...) and a dangerous word anywhere in its raw text, quoted or
// not, asks with "risky word inside shell expansion" when nothing else asked. Round 5: the quoted message of `git commit` and
// `gh pr|issue create|edit|comment` is data (lib/message-text.mjs), also `"$(cat <<'EOF' ... EOF)"`; a top-level heredoc is data only when cat/tee
// (or `git commit -F -`, `gh --body-file -`) reads it; gh words count by position; watch, parallel, PROMPT_COMMAND=, `script|expect -c`,
// `perl|python|node|ruby -e|-c|-p`, osascript, tmux, fish/pwsh/npx -c are hidden constructs. An exception inside the rules asks "guard error" (decideSafely; the log keeps the error class, not the command). A command over
// MAX_COMMAND_CHARS (32 KB) is not parsed at all: it asks "command too long to check"; the log and dialog keep only its first 2 KB, masked.
// Known limits (not detected): shell aliases and functions defined elsewhere, a variable assigned from another command's output, interpreter
// code (`node -e`, `python -c`) unless it names a dangerous word, wrappers that take the command as ONE string (busybox), rimraf,
// stdin paths that xargs hands to anything but rm -r, a credential sent by a tool off the sender list, copied first (`cp -r ~/.ssh /tmp/x`),
// piped into ssh from a `{ }` group or loop, or passed as an ssh argument (`ssh h "$(cat key)"`), `cd` scoping in subshells (treated as
// global: extra asks only), an ssh alias that hides a production host, and the PowerShell tool (the hook matcher covers Bash only).
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { bashCodeWrites } from './lib/code-writes.mjs';
import {
  checkDiskWipe, checkGhSecret, checkGit, checkHiddenRm, checkKeychainPrint, checkLockfileEdit, checkStdinRm, checkStdinScriptRm,
} from './lib/command-checks.mjs';
import { withoutCapturedPrints } from './lib/captured-read.mjs';
import { asGitSubcommand, commandOf } from './lib/command-of.mjs';
import { checkCredentialSend } from './lib/credential-send.mjs';
import { scanWrapped } from './lib/dangerous-scan.mjs';
import { editLogPath, recordEdit } from './lib/edit-log.mjs';
import { checkEval } from './lib/eval-check.mjs';
import { checkFind } from './lib/find-delete.mjs';
import { gitRunValueReasons, judgeOnce, lineFacts, valueReasons } from './lib/git-run-values.mjs';
import { GIT_UNREADABLE_REASON, gitRunReasons } from './lib/git-runs.mjs';
import { gitAdvice } from './lib/git-advice.mjs';
import { waitAdvice } from './lib/wait-advice.mjs';
import { outwardAsk } from './lib/outward.mjs';
import { readProdHosts, remoteAsk } from './lib/remote.mjs';
import { checkRm, expandHome, expandVars, isUnder, nativePath, newScope, sameFile, substituteKnownWords, trackAssignments } from './lib/rm-paths.mjs';
import { askUnlessRemembered } from './lib/remembered-ask.mjs';
import { adviceOnce } from './lib/bounce-once.mjs';
import { isAdviceReason, splitAdvice } from './lib/reason-classes.mjs';
import { findLiteralSecret } from './lib/secrets.mjs';
import { shellHazards } from './lib/shell-hazards.mjs';
import { askOwner } from './lib/timed-ask.mjs';
import { GIT_TOPLEVEL_WORD, lex, segments, tokenize } from './lib/shell-words.mjs';
import { riskyWordInExpansion, unreadableNameReasons } from './lib/raw-risk.mjs';
import { DESTRUCTIVE_PREFIX, isSecretOnlyReason, MAX_COMMAND_CHARS, secretReason } from './lib/verdict.mjs';

export { segments };

const SHELLS = new Set(['bash', 'sh', 'zsh', 'ksh', 'dash']);
const SHELL_OPTIONS_WITH_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const UNKNOWN_CD_TARGET = /^-|[~$`*?[\]{}]/;

const allow = () => ({ allow: true });
// Every rule is an ask. The hook turns it into a timed dialog (Allow by default, auto-allow after 2 min), or, the first time a
// reason can be fixed by rewriting the command, into a bounce (lib/bounce-once.mjs reads `reasons` one by one). Only a click on
// Deny denies for good. A destructive rule says so, so its dialog stands out.
const ask = (reasons) => ({ allow: false, ask: true, reason: reasons.join('; '), reasons });

/** Like expandHome; the git top-level word -> the project, but only from inside it (elsewhere the top-level is unknown). */
function expandCdTarget(target, cwd, project) {
  if (target !== GIT_TOPLEVEL_WORD && !target.startsWith(`${GIT_TOPLEVEL_WORD}/`)) return expandHome(target);
  const root = resolve(nativePath(project));
  const inside = sameFile(resolve(cwd), root) || isUnder(root, resolve(cwd));
  return inside ? root + target.slice(GIT_TOPLEVEL_WORD.length) : target;
}

/** Working directory after `cd`/`pushd`/`popd`: literal targets are resolved, anything else makes it unknown (null). */
function nextCwd(cmd, args, cwd, project, vars) {
  if (cmd === 'popd') return null;
  if (cmd !== 'cd' && cmd !== 'pushd') return cwd;
  if (cwd === null || args.length !== 1) return null;
  const target = expandVars(expandCdTarget(args[0], cwd, project), vars); // `cd "$D"` after `D=$(mktemp -d)` is the temp dir
  return UNKNOWN_CD_TARGET.test(target) ? null : resolve(cwd, nativePath(target));
}

/**
 * The `-c` script of a shell invocation: `-c` may sit anywhere in the option cluster or list (`-ec`, `-e -c`, `-c --`, `-o pipefail -c`).
 * @param {string[]} args words after the shell name
 * @returns {string | undefined} the script text, or undefined when this is not a `-c` call
 */
function shellScript(args) {
  let hasC = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return hasC ? args[i + 1] : undefined;
    if (SHELL_OPTIONS_WITH_VALUE.has(arg)) i++;
    else if (/^-[a-zA-Z]+$/.test(arg)) {
      hasC ||= arg.includes('c');
      if (/[oO]$/.test(arg)) i++; // `-eo pipefail`: the last letter takes the next word
    } else if (!arg.startsWith('-') && !arg.startsWith('+')) return hasC ? arg : undefined;
  }
  return undefined;
}

const HOST_VARIABLES = ['PGHOST', 'PGHOSTADDR', 'PGSERVICE', 'MYSQL_HOST'];

/** Host variables set earlier in the same command line (`export PGHOST=prod-db` then `psql`), as `NAME=value` words like a prefix assignment. */
const hostVariables = (vars = new Map()) => HOST_VARIABLES.filter((name) => vars.has(name)).map((name) => `${name}=${vars.get(name)}`);

/** `alias p='git push -f'`: the alias body is a command line, so it is judged like one; a body with advice only gives that advice. */
function checkAlias(args, env) {
  const bodies = args.filter((word) => word.includes('=')).map((word) => word.slice(word.indexOf('=') + 1));
  const reasons = bodies.flatMap((body) => reasonsOf(body, env));
  const asks = reasons.filter((reason) => !isAdviceReason(reason));
  return asks.length > 0 ? [`alias defines a command that asks: ${asks[0]}`] : reasons;
}

/** The rules that look at one command's own name and words, and the words before it (`before`: wrappers; no shell recursion, no scan). */
function checkSimple({ cmd, args, assigns, before }, env) {
  return [
    cmd === 'git' ? checkGit(args, assigns) : undefined,
    cmd === 'rm' ? checkRm(args, env) : undefined,
    cmd === 'find' ? checkFind(args, env) : undefined,
    checkHiddenRm(cmd, args),
    checkStdinRm(cmd, args, before),
    checkKeychainPrint(cmd, args),
    checkGhSecret(cmd, args),
    checkDiskWipe(cmd, args),
    checkLockfileEdit(cmd, args),
    outwardAsk(cmd, args) ?? remoteAsk(cmd, args, [...assigns, ...hostVariables(env.vars)], env.prodHosts),
    ...(cmd === 'alias' ? checkAlias(args, env) : []),
  ].filter((reason) => reason !== undefined);
}

const MAX_NESTING = 24; // bash -c / eval / $(...) levels checked; deeper asks (keeps a hostile command from overflowing the stack)

/** @returns {string[]} why this one command ({cmd, args, assigns, before}) needs an owner answer (empty when it does not) */
function checkCommand(command, env, nextWords) {
  const { cmd, args } = command;
  const script = SHELLS.has(cmd) ? shellScript(args) : undefined;
  if (script) return [checkStdinScriptRm(script, command.before), ...reasonsOf(script, env)].filter((reason) => reason !== undefined);
  const evalReasons = cmd === 'eval' ? checkEval(args, nextWords, (text) => reasonsOf(text, env)) : [];
  return [...checkSimple(command, env), ...evalReasons, ...(cmd === 'git' ? gitRunReasons(command, env, (text, inner) => judgeOnce(text, inner, reasonsOf), (text, inner, target) => valueReasons(text, inner, reasonsOf, target)) : [])];
}

/**
 * Every reason a command line needs an owner answer: a literal secret, then each simple command (checked as written, then
 * scanned for a dangerous command behind an unknown wrapper), then nested bodies. Variables assigned earlier in the line are
 * tracked in order, the last assignment wins.
 */
function reasonsOf(command, { cwd, project, prodHosts, parse = tokenize, depth = 0, judged = new Map(), line = lineFacts(command) }) {
  if (depth > MAX_NESTING) return ['commands are nested too deeply to check (bash -c / eval / $( ) inside each other); write them out flat'];
  const reasons = [];
  const secret = findLiteralSecret(command);
  if (secret !== undefined) reasons.push(secretReason(secret));
  const scope = newScope(cwd, project, command);
  const { segs, nested } = parse(command);
  const commands = [];
  let dir = cwd;
  segs.forEach((seg, index) => {
    const words = substituteKnownWords(seg, scope);
    const parsed = asGitSubcommand(commandOf(words));
    commands.push({ ...parsed, piped: seg.piped === true }); // credential-send follows a pipe into ssh
    const env = { cwd: dir, project, vars: scope.vars, splitWords: scope.splitWords, prodHosts, parse, depth: depth + 1, judged, line };
    reasons.push(...shellHazards({ seg, raw: commandOf(seg), parsed, shellScript }), ...gitRunValueReasons(words, parsed, env, reasonsOf), ...unreadableNameReasons(parsed.cmd, command, prodHosts));
    if (parsed.cmd !== undefined) {
      reasons.push(...checkCommand({ ...parsed, before: words.slice(0, parsed.at) }, env, segs[index + 1] ?? []));
      reasons.push(...scanWrapped(words, parsed, (cmd, args, at) => checkCommand({ cmd, args, assigns: [], before: words.slice(0, at) }, env, [])));
      dir = nextCwd(parsed.cmd, parsed.args, dir, project, scope.vars);
    }
    trackAssignments(scope, seg);
  });
  const credentialSend = checkCredentialSend(commands); // one command line: the file may be read in one command and sent by another
  if (credentialSend !== undefined) reasons.push(credentialSend);
  for (const inner of nested) reasons.push(...reasonsOf(inner, { cwd, project, prodHosts, parse, depth: depth + 1, judged, line }));
  return [...new Set(reasons)]; // a value many git commands run gives its reasons once, not once per command (the list stays short)
}

/**
 * Pure decision for one Bash command line. Never a deny: a rule hit is an ask (the hook shows a timed dialog or bounces it once),
 * and a destructive one (force push, rm outside the project, disk wipe) leads the reason. Advice may run git (lib/git-advice.mjs, 2 s for the line).
 * @param {string} command raw command text
 * @param {{cwd?: string|null, project?: string, prodHosts?: string[]}} ctx absolute paths (cwd null means "unknown
 *   directory") and the private production-host list (see lib/remote.mjs)
 * @returns {{allow: true, advice?: string[]} | {allow: false, ask: true, reason: string, reasons: string[], advice?: string[]}} reason
 *   joins every rule hit, destructive first; reasons holds the same hits one by one, in the same order; advice (present only when some
 *   quality rule hit) is never in reason or reasons: it never asks, and the hook shows it once (lib/bounce-once.mjs)
 */
export function decide(command, { cwd = process.cwd(), project = cwd, prodHosts = [] } = {}) {
  if (command.length > MAX_COMMAND_CHARS) return ask(['command too long to check; read it before allowing']);
  const ctx = { cwd, project, prodHosts };
  const primary = reasonsOf(command, ctx);
  // backstop: a second, independent parse (the character-level lexer) feeds the same rules; what only it finds is marked
  const known = new Set(primary);
  const backstop = reasonsOf(command, { ...ctx, parse: lex }).filter((reason) => !known.has(reason)).map((reason) => `${reason} (matched in raw text)`);
  const recheck = (text) => [...reasonsOf(text, ctx), ...reasonsOf(text, { ...ctx, parse: lex })];
  const found = withoutCapturedPrints([...new Set([...primary, ...backstop])], command, recheck); // `export T=$(gh auth token)` prints nothing
  const { asks: reasons, advice } = splitAdvice([...found, ...gitAdvice(command, cwd), ...waitAdvice(command)]); // advice never makes the backstop redundant
  // fail to ask: a hidden-execution construct next to a dangerous word asks even when both parsers saw nothing; a literal secret never hides
  // it (a secret-only ask is shortened and can be remembered, lib/remembered-ask.mjs), nor does the git-unreadable ask (it names no fix)
  const risky = riskyWordInExpansion(command, prodHosts);
  const hidesRisky = (reason) => !isSecretOnlyReason(reason) && !reason.startsWith(GIT_UNREADABLE_REASON);
  if (risky !== undefined && !reasons.some((reason) => reason.startsWith(risky) || hidesRisky(reason))) reasons.push(risky);
  reasons.sort((x, y) => Number(y.startsWith(DESTRUCTIVE_PREFIX)) - Number(x.startsWith(DESTRUCTIVE_PREFIX)));
  const verdict = reasons.length === 0 ? allow() : ask(reasons);
  return advice.length === 0 ? verdict : { ...verdict, advice };
}

export const GUARD_ERROR_REASON = 'guard error';

/**
 * `decide` that never fails open: an exception inside the rules asks ("guard error") instead of letting the command through unchecked.
 * @param {string} command raw command text
 * @param {Parameters<typeof decide>[1]} ctx same as decide
 * @param {typeof decide} rules the rules to run (injectable so a test can make them throw)
 * @returns {ReturnType<typeof decide> & {errorClass?: string}} the decision; after an exception an ask carrying the error class
 */
export function decideSafely(command, ctx, rules = decide) {
  try {
    return rules(command, ctx);
  } catch (error) {
    return { allow: false, ask: true, reason: GUARD_ERROR_REASON, errorClass: error instanceof Error ? error.name : typeof error };
  }
}

/** Code files this command may rewrite go to the edit log, so the Stop typecheck gate covers them. Never throws. */
function logCodeWrites(command, input, cwd) {
  try {
    const logPath = editLogPath(input.session_id, input.agent_id);
    if (logPath) for (const file of bashCodeWrites(command, cwd)) recordEdit(logPath, file);
  } catch {
    // logging is best effort: a failure here must never block a command
  }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return; // not hook JSON: nothing to guard
  }
  const command = input?.tool_input?.command;
  if (typeof command !== 'string') return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const project = process.env.CLAUDE_PROJECT_DIR || cwd;
  const rules = (text, ctx) => decide(text, { ...ctx, prodHosts: readProdHosts() }); // reading the host list is inside the guard too
  const r = decideSafely(command, { cwd, project }, rules);
  if (r.ask) process.stdout.write(askUnlessRemembered(r, { command, cwd, input, recheck: (text) => decideSafely(text, { cwd, project }, rules) }));
  else if (r.advice) process.stdout.write(adviceOnce(r.advice, { command, cwd, input })); // advice only: never the owner
  logCodeWrites(command, input, cwd); // harmless when the owner denied: the typecheck gate only reads files that exist
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

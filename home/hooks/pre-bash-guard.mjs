// PreToolUse guard for Bash calls, and PowerShell calls too (the matcher is `Bash|PowerShell` in settings/base.json). Reads the hook JSON from stdin, never
// evaluates the command. Parsing lives in lib/shell-words.mjs and lib/command-of.mjs. Exports: decide(command, {cwd, project, prodHosts}) -> {allow: true,
// advice?} | {allow: false, ask: true, reason, reasons, advice?}; segments(command) -> string[][]. Nothing is denied for good. Every safety rule hit is an
// ASK, and the hook answers it with a timed native dialog (lib/timed-ask.mjs: Allow is the default, no answer in 2 min (CLAUDE_ASK_TIMEOUT_S) goes ahead as
// Allow, only a click on Deny denies); with no GUI (ssh, CI, no display) or a failing dialog it falls back to the CLI's own "ask" prompt, which also appears
// in bypassPermissions mode (verified on CLI 2.1.323). Bounce once (lib/bounce-once.mjs): when a reason can be fixed by rewriting the command (a variable
// command word, a risky word inside shell expansion, arithmetic or a word filled in at run time), the first send is denied with the rewrite instead, naming by
// class (lib/reason-classes.mjs) any other reason that will still ask; the identical command sent again gets the ask above. ADVICE (quality rules: a
// hand-edited lockfile, a merge that can create a merge commit, a branch moved by update-ref, a copy of an existing lane branch, a fast-forward merge into the
// base without a suite PASS: lib/git-advice.mjs, a `for|while|until` loop that sleeps 5 s or more or a single sleep of 30 s or more, unless sent with
// run_in_background: true or by Monitor (tool_name "Monitor": lib/wait-advice.mjs), a `docker rm` without -v (lib/docker-advice.mjs)) never asks: alone, the
// first send is denied with the fix and the identical retry runs; next to an ask or bounce it is appended (table: lib/bounce-once.mjs). Every ask and its
// outcome is logged (lib/guard-log.mjs, no secrets). Rules. DESTRUCTIVE (the dialog says "DESTRUCTIVE: ..."): force push (incl. -fu clusters and +refspec),
// `push --mirror`, remote branch delete, rm -r of a whole folder (the working directory, a bare glob such as `*` or `./**/*` of it, the project root, home,
// `/`: lib/rm-paths.mjs), rm -r outside the project (temp dirs allowed, judged from every folder the line's `cd`s may have led to: lib/cd-folder.mjs, `cd` to
// `~`, `$HOME` and `$(git rev-parse --show-toplevel)` (from inside the project only) is resolved, as are leading `~`/`$HOME`/`$TMPDIR`/`$CLAUDE_PROJECT_DIR`
// and variables assigned earlier in the line (the last assignment wins, `VAR=$(mktemp -d)` is the temp dir, `..` is resolved after substitution; an unknown
// variable asks for `rm -r` only; lib/rm-paths.mjs; $HOME, `/` and a drive root never count as the project), disk wipes (dd of=/dev/x, mkfs, wipefs,
// shred/blkdiscard on a device), rm -r run by xargs or parallel, also inside the `sh -c` script they run (its targets come from stdin; `xargs rm -f` is fine;
// lib/command-checks.mjs). The other deleters, on the same target rules (lib/other-deleters.mjs, round 9): a find that deletes without a name test (its start
// folder is the target: lib/find-delete.mjs), rimraf, `rsync --delete`, `powershell|pwsh -Command` Remove-Item -Recurse, `cmd /c` rd /s, and
// `node|python|perl|ruby -e|-c` code with a recursive delete call (a path the guard cannot read asks); a recursive delete through a link made earlier in the
// line (`ln -s .. up && rm -rf up/*`). Plain ask: a write, removal, link or FIFO under ~/.claude/private or the guard's own state. `rm -r .` and `rm -r ./`
// never ask (rm refuses them), nor does a bare glob of the folder this line's `mktemp -d` made. A nested body (`$(...)`, backticks) of a line that has a `cd`,
// `pushd` or `popd` is judged with the folder unknown. Plain ASK: git --no-verify (and unique prefixes), `git -c core.hooksPath`, `HUSKY=0 git`, `git push`
// (not --dry-run), `git update-ref` (every time), `gh release *`, `gh pr merge`, the merge and release verbs of glab, hub (which also gets the git rules) and
// tea, package publish (lib/outward.mjs), ssh/scp/rsync/psql/mysql that write to a production host (lib/remote.mjs; list in ~/.claude/private/prod-hosts),
// `security find-*-password -w|-g` (not of the account tool's own service: lib/account-reads.mjs) / `dump-keychain` / `export` and `gh auth token` (print a
// stored secret), `gh ssh-key add` of a file that is not `*.pub`, and a private credential file (`.ssh/id_*` or any non-public file directly under `.ssh`,
// `.aws/credentials`, `.netrc`, gh `hosts.yml`, `.kube/config`, `.npmrc`, `.docker/config.json`, `.pypirc`) in one command line with a network sender or cloud
// upload (`aws s3 cp`, `gsutil cp`, `rclone copy` ...), a whole `~/.ssh` / `.aws` / `.gnupg` folder given to a sender or archived before one, or a credential
// fed to ssh's stdin, unless it is the value of an identity flag (`ssh|scp|sftp -i`, curl `--key`; lib/credential-send.mjs). A literal secret
// (lib/secrets.mjs) never asks or bounces (owner G1): decide returns its kind, the hook logs only that. ALLOW: `sed -i`, heredoc and inline-interpreter writes
// to code files are allowed. Everything else (and any command text it cannot parse) is allowed. Reading files, `.env` included, is never blocked. This is a
// safety net against model mistakes, not a sandbox. Invariants: it never executes the command, it never fails open on its own errors (hook input that is not
// JSON with a string command asks "the guard could not read its input"; once a command was read, an exception anywhere asks "guard error": decideSafely for
// the rules, main for everything after them; a hook process that dies or times out blocks the call through `onFailure: "block"` in settings/base.json, which
// Claude Code honours from 2.1.295: scripts/doctor.sh checks the version), and it prefers a missed block over a false block of a normal dev command. Position
// independence: after the command word, every later word that is a dangerous verb (rm, git, dd, mkfs, gh, publish, ssh, psql, shells ...) is checked as a
// command too, so unknown wrappers (`ionice -c3 rm -rf /x`) need no list (lib/dangerous-scan.mjs); the scan is skipped after echo/grep/man/git/docker/ssh and
// similar. `$'\x72m'` ANSI-C words are decoded (lib/ansi-c.mjs); `eval` of a variable or substitution asks (lib/eval-check.mjs; `eval "$(ssh-agent -s)"` style
// tool init is silent); a variable command word asks. Handled: `& && || ; |` and newlines as separators; `( ) {` groups, `$(...)` and backticks (also inside
// double quotes) re-checked as commands; leading `! if then do else elif while until`; command matched by basename (`/bin/rm`, `\rm`) through wrappers
// command/builtin/env/sudo/doas/ nohup/xargs/exec/nice/timeout/stdbuf/time/sshpass; `bash -c '...'` and every command git itself runs (lib/git-runs.mjs:
// `rebase -x`, `-c core.pager=`, GIT_SSH_COMMAND ...) are decided recursively; `git-<sub>` programs are git (lib/command-of.mjs); git-run variables are judged
// where assigned (lib/git-run-values.mjs). Two parsers, one rule set: the regex tokenizer (lib/shell-words.mjs) and an independent character-level lexer
// (lib/shell-lexer.mjs: quotes, comments, `$((..))`, `$(...)` inside double quotes, heredocs wherever they really start) both feed reasonsOf; `decide` merges
// them, and a reason only the lexer found ends with "(matched in raw text)". So `out="$(git push origin)"` and `git commit -m "see <<EOF"` + `git push -f` are
// caught whatever the quoting. Commands that hide what runs always ask (lib/shell-hazards.mjs): `| bash`, `bash <<EOF`, `sh -s`, a variable/`$(...)`/backtick
// as or inside the command word (`$X`, `git$IFS'push'`; `$EDITOR` and an earlier one-word assignment are fine), `$IFS` anywhere, an interpreter (python, node,
// perl, ruby, deno, bun, php) fed its code by a pipe or a file (from a heredoc the code is judged), interpreter code that builds the command it runs from
// pieces and PowerShell -EncodedCommand (lib/inline-code.mjs), `env -S`, `su -c`; `pnpm exec|dlx`, `yarn exec`, `npx` ... scan what they run (`npm run`/`pnpm
// run` do not). Brace expansion in rm paths is expanded (lib/braces.mjs), or asks when it cannot be listed. `git -c alias.*`, `gh api -X
// PUT|POST|PATCH|DELETE` on repo/merge/release paths, `gh repo delete`, `gh repo edit --visibility`, `gh secret set`, `gh workflow run`, a `gh api graphql`
// mutation, `diskutil erase*` and `apfs delete*`, `newfs_*`, `> /dev/disk*`, `cp|mv|tee ... /dev/disk*|sd*|nvme*`, an `alias` whose body would ask ask.
// PGHOST/PGSERVICE/MYSQL_HOST set earlier in the line count as the host of a later psql/mysql. Prod SQL with a `$tag$` quote, a backslash escape or `;`
// followed by more text is not read-only. Nesting deeper than MAX_NESTING asks. An unquoted `$X` with blanks is judged by every rule as zsh (one word) and as
// bash (split) reads it (`X="push -f"; git $X`). Arithmetic on anything but numbers bounces, as does a word filled in at run time (`read X; git $X`, `"$@"`)
// in a checked command (lib/runtime-values.mjs); a plain `for` list is judged per value (lib/loop-values.mjs). Fail to ask (Round 4, lib/raw-risk.mjs): the
// two parsers are not a security boundary. A command that has ANY hidden-execution construct (`$(`, backtick, `<<`, `<(`, eval, trap, case, `\r`, a pipe into
// a shell ...) and a dangerous word anywhere in its raw text, quoted or not, asks with "risky word inside shell expansion" when nothing else asked. Round 5:
// the quoted message of `git commit` and `gh pr|issue create|edit|comment` is data (lib/message-text.mjs), also `"$(cat <<'EOF' ... EOF)"`; a top-level
// heredoc is data only when cat/tee (or `git commit -F -`, `gh --body-file -`) reads it; gh words count by position; watch, parallel, PROMPT_COMMAND=,
// `script|expect -c`, `perl|python|node|ruby -e|-c|-p`, osascript, tmux, fish/pwsh/npx -c are hidden constructs. An exception inside the rules asks "guard
// error" (decideSafely; the log keeps the error class, not the command). A command over MAX_COMMAND_CHARS (32 KB) is not parsed at all: it asks "command too
// long to check"; the log and dialog keep only its first 2 KB, masked. One work budget bounds the rest (lib/rm-paths.mjs): a line whose variables fill in more
// than MAX_LINE_EXPANDED_CHARS, or whose rm targets expand to more than MAX_LINE_READINGS words, asks "command too complex to check". Known limits (not
// detected): shell aliases and functions defined elsewhere (also in a file `source` reads), a variable assigned from another command's output, interpreter
// code read from a file or stdin or whose delete call is not one the deleter rules list (lib/other-deleters.mjs), PowerShell -File, cmd `^` escapes and
// `%VAR%` paths, wrappers that take the command as ONE string (busybox), stdin paths that xargs hands to anything but rm -r, a credential sent by a tool off
// the sender list, copied first (`cp -r ~/.ssh /tmp/x`), piped into ssh from a `{ }` group or loop, or passed as an ssh argument (`ssh h "$(cat key)"`), a
// function body that runs after a later `cd`, a `cd` behind an unknown wrapper, a command of a loop body that runs again after a `cd` later in the body (a
// `cd` that may not have taken effect is judged from the folder before it and the one after; a relative one in a loop or a function body makes the folder
// unknown: relative rm -r targets then ask), an ssh alias that hides a production host, a link made by an earlier command line, and PowerShell syntax: a
// PowerShell tool call (the tool is off on Windows, settings/windows.json) is read by these shell rules, which fit only its plain words. OUTPUT TRIM
// (lib/output-trim.mjs): a plain test or build runner call that the rules let run is rewritten (updatedInput) to print the full log's path first, then
// only the last 150 lines of its output, with the runner's exit code; opt-in, CLAUDE_GUARD_TRIM=1 turns it on.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  checkDiskWipe, checkGhSecret, checkGit, checkHiddenRm, checkKeychainPrint, checkLockfileEdit, checkStdinRm, checkStdinScriptRm,
} from './lib/command-checks.mjs';
import { withoutCapturedPrints } from './lib/captured-read.mjs';
import { commandOf } from './lib/command-of.mjs';
import { checkCredentialSend } from './lib/credential-send.mjs';
import { dockerRmAdvice } from './lib/docker-advice.mjs';
import { scanWrapped } from './lib/dangerous-scan.mjs';
import { checkEval } from './lib/eval-check.mjs';
import { checkFind } from './lib/find-delete.mjs';
import { INLINE_COMMAND_REASON, checkInlineCode } from './lib/inline-code.mjs';
import { SHELLS, checkLinkedDelete, checkOtherDeleter, shellScript, withoutDotTargets } from './lib/other-deleters.mjs';
import { checkGuardStateWrite } from './lib/guard-state-write.mjs';
import { gitRunValueReasons, judgeOnce, lineFacts, valueReasons } from './lib/git-run-values.mjs';
import { GIT_UNREADABLE_REASON, gitRunReasons } from './lib/git-runs.mjs';
import { gitAdvice } from './lib/git-advice.mjs';
import { waitAdvice, withoutWaitAdvice } from './lib/wait-advice.mjs';
import { outwardAsk } from './lib/outward.mjs';
import { trimAnswer } from './lib/output-trim.mjs';
import { hostVariables, readProdHosts, remoteAsk } from './lib/remote.mjs';
import { TOO_COMPLEX_REASON, checkRm, newScope, newWork, runsInOrder, substituteKnownWords, trackAssignments } from './lib/rm-paths.mjs';
import { groupBranches } from './lib/bare-glob.mjs';
import { enterSegment, leaveSegment, maybeFolders, newFolder, possibleFolders } from './lib/cd-folder.mjs';
import { askOrBounce, logSecretKind } from './lib/remembered-ask.mjs';
import { newLoopWalk, segmentViews, stepLoopWalk } from './lib/loop-values.mjs';
import { adviceOnce } from './lib/bounce-once.mjs';
import { isAdviceReason, splitAdvice } from './lib/reason-classes.mjs';
import { findLiteralSecret } from './lib/secrets.mjs';
import { commandReadings, shellHazards } from './lib/shell-hazards.mjs';
import { arithmeticReasons } from './lib/runtime-values.mjs';
import { GUARD_ERROR_REASON, failedAnswer, plainAsk, readHookInput, UNREADABLE_INPUT_REASON } from './lib/guard-fallback.mjs';
import { lex, segments, tokenize } from './lib/shell-words.mjs';
import { riskyWordInExpansion, unreadableNameReasons } from './lib/raw-risk.mjs';
import { DESTRUCTIVE_PREFIX, MAX_COMMAND_CHARS } from './lib/verdict.mjs';
export { segments, GUARD_ERROR_REASON, UNREADABLE_INPUT_REASON };
const allow = () => ({ allow: true });
// Every rule is an ask. The hook turns it into a timed dialog (Allow by default, auto-allow after 2 min), or, the first time a reason can be fixed by
// rewriting the command, into a bounce (lib/bounce-once.mjs reads `reasons` one by one). Only a click on Deny denies for good; a destructive rule says so.
const ask = (reasons) => ({ allow: false, ask: true, reason: reasons.join('; '), reasons });

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
    cmd === 'git' || cmd === 'hub' ? checkGit(args, assigns) : undefined, // hub runs git (`hub push`)
    cmd === 'rm' ? checkRm(withoutDotTargets(args, env.groupTargets), env) : undefined, // rm refuses `.` and `./`
    cmd === 'find' ? checkFind(args, env) : undefined,
    checkOtherDeleter(cmd, args, env), // rimraf, rsync --delete, PowerShell, cmd, interpreter code (lib/other-deleters.mjs)
    checkInlineCode(cmd, args), // code that builds the command it runs, PowerShell -EncodedCommand (lib/inline-code.mjs)
    checkGuardStateWrite(cmd, [...before, ...args], env.cwd), // ~/.claude/private and the guard's own state (lib/guard-state-write.mjs)
    checkHiddenRm(cmd, args),
    checkStdinRm(cmd, args, before),
    checkKeychainPrint(cmd, args),
    checkGhSecret(cmd, args),
    checkDiskWipe(cmd, args),
    checkLockfileEdit(cmd, args), dockerRmAdvice(cmd, args), // two advice rules: they never ask (lib/reason-classes.mjs)
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
  const judgeValue = (text, inner, target) => valueReasons(text, inner, reasonsOf, target);
  const gitReasons = cmd === 'git' ? gitRunReasons(command, env, (text, inner) => judgeOnce(text, inner, reasonsOf), judgeValue) : [];
  return [...checkSimple(command, env), ...evalReasons, ...gitReasons];
}

/**
 * Every reason a command line needs an owner answer: each simple command (checked as written, then scanned for a dangerous command
 * behind an unknown wrapper), then nested bodies. Variables assigned earlier in the line are tracked in order, the last assignment wins.
 */
function reasonsOf(command, context) {
  const { cwd, project, prodHosts, parse = tokenize, depth = 0, judged = new Map(), line = lineFacts(command), work = newWork(), maybeCwds = [] } = context;
  if (depth > MAX_NESTING) return ['commands are nested too deeply to check (bash -c / eval / $( ) inside each other); write them out flat'];
  const reasons = [];
  const scope = newScope(cwd, project, command, work);
  if (depth > 0) scope.sameLine.templates.clear(); // a nested script cannot see outer-line commands that may make its mktemp fail
  const { segs, nested } = parse(command);
  const commands = [];
  const folder = newFolder(cwd); // the folders the line's `cd`s may have led to (lib/cd-folder.mjs)
  const loops = newLoopWalk(command);
  segs.forEach((seg, index) => {
    const readings = commandReadings(substituteKnownWords(seg, scope), scope.splitWords); // `X="push -f"; git $X` as zsh, then as bash reads it
    const { words, parsed } = readings[0];
    commands.push({ ...parsed, piped: seg.piped === true }); // credential-send follows a pipe into ssh
    enterSegment(folder, seg, parsed, words);
    // judged in each folder it may run in, each reading of its words, once per value of a plain `for` list it uses (lib/loop-values.mjs)
    for (const view of segmentViews(seg, scope, loops, readings)) {
      const bareWords = new Set([...(seg.bareWords ?? [])].map((at) => view.readings[0].words[at])); // `$NAME` outside quotes: bash splits its value
      for (const [dir, { words: read, parsed: run }] of possibleFolders(folder, seg, work).flatMap((dir) => view.readings.map((reading) => [dir, reading]))) {
        const env = { cwd: dir, maybeCwds: [...maybeFolders(folder), ...maybeCwds], groupTargets: groupBranches(segs, index), project, vars: scope.vars, splitWords: scope.splitWords,
          bareWords, prodHosts, parse, depth: depth + 1, judged, line, work, inOrder: runsInOrder({ folder, segs, at: index, depth, before: read.slice(0, run.at) }) };
        reasons.push(...shellHazards({ seg: view.seg, raw: commandOf(view.seg), parsed: run, shellScript, line: command }),
          ...gitRunValueReasons(read, run, env, reasonsOf), ...unreadableNameReasons(run.cmd, command, prodHosts));
        if (run.cmd === undefined) continue;
        const wrapped = (cmd, args, at) => checkCommand({ cmd, args, assigns: [], before: read.slice(0, at) }, { ...env, inOrder: false }, []);
        reasons.push(...checkCommand({ ...run, before: read.slice(0, run.at) }, env, segs[index + 1] ?? []), ...scanWrapped(read, run, wrapped));
      }
    }
    if (parsed.cmd !== undefined) leaveSegment(folder, parsed, { project, scope });
    trackAssignments(scope, seg);
    stepLoopWalk(loops, seg);
  });
  // one command line: the file may be read in one command and sent by another; a link made in one command may be deleted through in another
  reasons.push(...[checkCredentialSend(commands), checkLinkedDelete(commands)].filter((reason) => reason !== undefined), ...arithmeticReasons(command));
  // a nested body (`$(...)`, backticks) may run after any of the line's `cd`s: once the line has one, its folder is unknown there
  const nestedCwd = folder.moved ? { cwd: null, maybeCwds: [...maybeFolders(folder), ...maybeCwds] } : { cwd, maybeCwds };
  for (const inner of nested) reasons.push(...reasonsOf(inner, { ...nestedCwd, project, prodHosts, parse, depth: depth + 1, judged, line, work }));
  // a value many git commands run gives its reasons once (the list stays short); a line over its work budget asks, whatever else it holds
  return [...new Set(work.spent ? [...reasons, TOO_COMPLEX_REASON] : reasons)];
}

/**
 * Pure decision for one Bash command line. Never a deny: a rule hit is an ask (the hook shows a timed dialog or bounces it once),
 * and a destructive one (force push, rm outside the project, disk wipe) leads the reason. Advice may run git (lib/git-advice.mjs, 2 s for the line).
 * @param {string} command raw command text
 * @param {{cwd?: string|null, project?: string, prodHosts?: string[], sessionId?: unknown}} ctx absolute paths (cwd null means "unknown directory"),
 *   the private production-host list (see lib/remote.mjs) and the hook input's session_id (its own scratch folder, lib/scratch-area.mjs);
 *   `work` is the line's work budget (lib/rm-paths.mjs newWork), which only a test passes
 * @returns {{allow: true, advice?: string[], secret?: string} | {allow: false, ask: true, reason: string, reasons: string[], advice?: string[], secret?: string}} reason
 *   joins every rule hit, destructive first; reasons holds the same hits one by one, in the same order; advice (present only when some
 *   quality rule hit) is never in reason or reasons: it never asks, and the hook shows it once (lib/bounce-once.mjs); secret: the kind of a literal secret (G1: logged only)
 */
export function decide(command, { cwd = process.cwd(), project = cwd, prodHosts = [], sessionId, work = newWork(sessionId) } = {}) {
  if (command.length > MAX_COMMAND_CHARS) return ask(['command too long to check; read it before allowing']);
  const ctx = { cwd, project, prodHosts, work }; // one budget for both parsers and every re-check of this line
  const primary = reasonsOf(command, ctx);
  // backstop: a second, independent parse (the character-level lexer) feeds the same rules; what only it finds is marked
  const known = new Set(primary);
  const backstop = reasonsOf(command, { ...ctx, parse: lex }).filter((reason) => !known.has(reason)).map((reason) => `${reason} (matched in raw text)`);
  const recheck = (text) => [...reasonsOf(text, ctx), ...reasonsOf(text, { ...ctx, parse: lex })];
  const found = withoutCapturedPrints([...new Set([...primary, ...backstop])], command, recheck); // `export T=$(gh auth token)` prints nothing
  const { asks: reasons, advice } = splitAdvice([...found, ...gitAdvice(command, cwd), ...waitAdvice(command)]); // advice never makes the backstop redundant
  // fail to ask: a hidden construct next to a dangerous word asks even when both parsers saw nothing (the git-unreadable ask names no fix)
  const risky = riskyWordInExpansion(command, prodHosts);
  const hidesRisky = (reason) => !reason.startsWith(GIT_UNREADABLE_REASON) && !reason.startsWith(INLINE_COMMAND_REASON); // keeps DESTRUCTIVE
  if (risky !== undefined && !reasons.some((reason) => reason.startsWith(risky) || hidesRisky(reason))) reasons.push(risky);
  reasons.sort((x, y) => Number(y.startsWith(DESTRUCTIVE_PREFIX)) - Number(x.startsWith(DESTRUCTIVE_PREFIX)));
  const secret = findLiteralSecret(command); // owner G1: never a reason, only its kind for the log (the raw text covers nested bodies too)
  return { ...(reasons.length === 0 ? allow() : ask(reasons)), ...(advice.length > 0 ? { advice } : {}), ...(secret !== undefined ? { secret } : {}) };
}

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

const cwdOf = (input) => (typeof input.cwd === 'string' ? input.cwd : process.cwd());

/** The hook's answer for one Bash call: '' lets it run, anything else is the ask, deny or rewrite (lib/output-trim.mjs) line for stdout. */
function answerFor(command, input) {
  const cwd = cwdOf(input);
  const project = process.env.CLAUDE_PROJECT_DIR || cwd;
  const rules = (text, ctx) => decide(text, { ...ctx, prodHosts: readProdHosts() }); // reading the host list is inside the guard too
  const decided = decideSafely(command, { cwd, project, sessionId: input.session_id }, rules);
  const r = input.tool_input.run_in_background === true || input.tool_name === 'Monitor' ? withoutWaitAdvice(decided) : decided; // waits the right way
  if (r.secret !== undefined) logSecretKind(r.secret, { cwd, input }); // owner G1: noted, never asked
  if (r.ask) return askOrBounce(r, { command, cwd, input });
  return r.advice ? adviceOnce(r.advice, { command, cwd, input }) : trimAnswer(input); // advice only: never the owner
}

async function main() {
  const input = await readHookInput();
  if (input === undefined) return void process.stdout.write(plainAsk(UNREADABLE_INPUT_REASON, {}));
  const { command } = input.tool_input;
  let answer;
  try {
    answer = answerFor(command, input);
  } catch (error) {
    answer = failedAnswer(error, input);
  }
  process.stdout.write(answer);
}

// ~/.claude/hooks is a symlink into this repo and import.meta.url is the resolved path, so compare real paths.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();

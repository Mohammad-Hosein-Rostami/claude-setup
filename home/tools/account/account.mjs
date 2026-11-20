#!/usr/bin/env node
// Purpose: the account tool behind the shell functions `claude-account` and `claude-as` (home/shell/claude-as.sh):
// one login token per account in the system's secure store, names and non-secret fields in accounts.json.
// Usage: account.mjs list | names | add <name> | once | token <name> | remove <name> | check [name]
//                    | default <name>|none | plan <name> pro|max|ultra | credits-off <name>
//   add   reads one pasted line from stdin (the token or the whole export line), checks it with one Haiku call, stores it
//   once  reads the same from stdin, checks it and prints the token (for `claude-as --once`); stores nothing
//   token prints the stored token: the only other command that prints one
// Invariants: a token is never an argument (one that looks like a token is refused), never in a message, a log or a
// usage row; `token` and `once` refuse a terminal as output and a session of Claude (CLAUDECODE set: their output
// would enter a transcript), `add` refuses a terminal as input and a session of Claude.
// Exit codes: 0 done, 1 refused or failed, 2 usage (also a bad name), 3 no such account, 4 wrong place (terminal, Claude).
import { readSync, realpathSync } from 'node:fs';
import { isatty } from 'node:tty';
import { addAccount, listAccounts, recordCheck, removeAccount, setCreditsOff, setDefault, setPlan } from './lib/accounts.mjs';
import { CHECK_REVOKED, CHECK_VALID, checkToken } from './lib/check.mjs';
import { AccountError, PASTE_MAX_BYTES, assertName, looksLikeToken, tokenFromPaste } from './lib/names.mjs';
import { readRegistry } from './lib/registry.mjs';
import { openStore } from './lib/store.mjs';

const EXIT = { ok: 0, refused: 1, usage: 2, unknown: 3, wrongPlace: 4 };
const USAGE = 'usage: claude-account list | add <name> | remove <name> | check [name] | default <name>|none | plan <name> pro|max|ultra | credits-off <name>';
const KIND_EXIT = { name: EXIT.usage, usage: EXIT.usage, unknown: EXIT.unknown };
const STDIN = 0;
const STDOUT = 1;
const usage = (message = USAGE) => new AccountError('usage', message);
const wrongPlace = (message) => Object.assign(new AccountError('place', message), { exit: EXIT.wrongPlace });

/**
 * One pasted line from stdin, which must be a pipe (the shell function writes it there with a builtin). `isatty` is asked,
 * not `process.stdin`: touching that stream makes the pipe non-blocking and a read here could then fail with EAGAIN.
 */
function readPaste(env) {
  if (env.CLAUDECODE) throw wrongPlace('this is a Claude session: run claude-as <name> in a normal terminal and paste at its hidden prompt');
  if (isatty(STDIN)) throw wrongPlace('paste at the hidden prompt of claude-as <name> in a normal terminal, not here');
  const buffer = Buffer.alloc(PASTE_MAX_BYTES + 1);
  let length = 0;
  for (let read = -1; read !== 0 && length <= PASTE_MAX_BYTES; length += read) read = readSync(STDIN, buffer, length, buffer.length - length, null);
  return tokenFromPaste(buffer.toString('utf8', 0, length));
}

function refuseScreen(env) {
  if (env.CLAUDECODE) throw wrongPlace('this is a Claude session: a token printed here would enter its transcript; not printed');
  if (isatty(STDOUT)) throw wrongPlace('the output is a terminal: a token is never shown on the screen; use claude-as <name>');
}

/** The pasted token, refused when the server says it is revoked. Returns the token and the check result. */
async function checkedPaste(name, env) {
  const token = readPaste(env);
  const result = await checkToken(name, token, { env });
  if (result === CHECK_REVOKED) throw new AccountError('revoked', 'the token was refused: revoked or not valid (the server answered 401). Nothing was stored. Make a new one with: claude setup-token');
  return { token, result };
}

function listLine(row) {
  const where = row.inThisTerminal === 'yes' ? '  [this terminal]' : row.inThisTerminal === 'name only' ? '  [named here, but this shell holds another token]' : '';
  const checked = row.checked ? `${row.checked.result} (checked ${row.checked.at.slice(0, 10)})` : 'not checked';
  const credits = row.creditsOff ? 'off (owner said)' : 'not confirmed off';
  return `${row.name}${where}  added ${row.added.slice(0, 10)}, ${row.daysLeft} days left  ${checked}  plan ${row.plan ?? 'unknown'}  usage credits: ${credits}${row.isDefault ? '  [default]' : ''}`;
}

async function checkAccounts(name, env) {
  const store = openStore(env);
  const names = name ? [assertName(name)] : Object.keys(readRegistry(env).accounts).sort();
  let allValid = true;
  for (const each of names) {
    const token = store.get(each);
    if (token === null) throw new AccountError('unknown', `no account named ${each}`);
    const result = await checkToken(each, token, { env });
    recordCheck(each, result, { env });
    console.log(`${each}: ${result}`);
    allValid &&= result === CHECK_VALID;
  }
  return allValid ? EXIT.ok : EXIT.refused;
}

const COMMANDS = {
  list: { args: 0, run: (_, env) => { const rows = listAccounts({ env }); console.log(rows.length ? rows.map(listLine).join('\n') : 'no accounts stored. Add one: claude-as <name>'); } },
  names: { args: 0, run: (_, env) => { process.stdout.write(Object.keys(readRegistry(env).accounts).sort().map((name) => `${name}\n`).join('')); } },
  add: { args: 1, run: async ([name], env) => { assertName(name); const { token, result } = await checkedPaste(name, env); addAccount(name, token, { env, checked: result }); console.log(`stored account ${name}: ${result}`); } },
  once: { args: 0, run: async (_, env) => { refuseScreen(env); const { token } = await checkedPaste(null, env); process.stdout.write(`${token}\n`); } },
  token: { args: 1, run: ([name], env) => { refuseScreen(env); const token = openStore(env).get(assertName(name)); if (token === null) throw new AccountError('unknown', `no account named ${name}`); process.stdout.write(`${token}\n`); } },
  remove: { args: 1, run: ([name], env) => { if (!removeAccount(name, { env })) throw new AccountError('unknown', `no account named ${name}`); console.log(`removed account ${name}`); } },
  check: { args: [0, 1], run: ([name], env) => checkAccounts(name, env) },
  default: { args: 1, run: ([name], env) => { setDefault(name === 'none' ? null : name, { env }); console.log(name === 'none' ? 'no default account' : `default account: ${name}`); } },
  plan: { args: 2, run: ([name, plan], env) => { setPlan(name, plan, { env }); console.log(`${name}: plan ${plan}`); } },
  'credits-off': { args: 1, run: ([name], env) => { setCreditsOff(name, { env }); console.log(`${name}: usage credits off (owner said)`); } },
};

/**
 * Runs one command.
 * @param {string[]} argv the command and its arguments.
 * @param {object} env the environment (the store, the accounts folder, CLAUDECODE, CLAUDE_ACCOUNT).
 * @returns {Promise<number>} the exit code.
 */
export async function main(argv, env = process.env) {
  try {
    if (argv.some(looksLikeToken)) throw usage('an argument looks like a token: a token is never an argument. Run claude-as <name> and paste at its hidden prompt');
    const command = Object.hasOwn(COMMANDS, argv[0]) ? COMMANDS[argv[0]] : null;
    if (!command || ![command.args].flat().includes(argv.length - 1)) throw usage();
    return (await command.run(argv.slice(1), env)) ?? EXIT.ok;
  } catch (error) {
    if (!(error instanceof AccountError)) throw error;
    console.error(`claude-account: ${error.message}`);
    return error.exit ?? KIND_EXIT[error.kind] ?? EXIT.refused;
  }
}

// realpath: the tool is also started through the link ~/.claude/tools.
if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) process.exitCode = await main(process.argv.slice(2));

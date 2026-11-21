// Purpose: the one stored-secret read the Bash guard lets run with no ask: a Keychain read of the account tool's own
// service (home/tools/account, service `claude-setup-account`). The owner allows token reads (2026-11-19: "its ok because
// these tokens are temeporry and i change them all the time so its ok to read them if they needed them"); printing one
// into a reply, a report or a command line stays forbidden by his rules, and a PreToolUse guard never sees the output.
// Exports: isAccountTokenRead(sub, rest).
// Invariants: an allowlist on the parsed words (principle P4): `find-generic-password` with `-s claude-setup-account`
// exactly once, and otherwise only `-w`, `-g`, `-a <account name>` and at most one keychain file (`*.keychain`,
// `*.keychain-db`). Any other word, a second `-s`, a joined cluster (`-ws`, `-sclaude-setup-account`), another service
// or `find-internet-password` is not this read: the caller keeps its ask. Pure, no I/O, no throw.
// The other token reads the owner allowed need no exemption: `account.mjs token`, reads of the accounts folder and the
// commands that print the token variable (`env`, `printenv`, `echo "$CLAUDE_CODE_OAUTH_TOKEN"`, `ps eww`, `export -p`,
// `declare -x`, `set`) match no guard rule. The literal-secret check on a command's text (lib/secrets.mjs) still asks.
// The guard imports nothing outside home/hooks (a copy of the hooks folder must run alone, tests/pre-bash-guard-final.test.mjs),
// so these two are copies: KEYCHAIN_SERVICE of home/tools/account/lib/keychain-store.mjs and NAME_PATTERN of lib/names.mjs
// there. Keep them equal (a phase-8 test pins it); a drift only makes the read ask again.
const KEYCHAIN_SERVICE = 'claude-setup-account';
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const OWN_LOOKUP = 'find-generic-password';
const PRINT_FLAGS = new Set(['-w', '-g']);
const KEYCHAIN_FILE = /^[^-].*\.keychain(?:-db)?$/;

/**
 * True when one parsed `security` call is a read of the account tool's own Keychain items, and nothing more.
 * @param {string} sub the `security` subcommand (after its global options)
 * @param {string[]} rest the words after the subcommand
 * @returns {boolean} true only for the allowlisted shape above; false for anything else (the existing ask stays)
 */
export function isAccountTokenRead(sub, rest) {
  if (sub !== OWN_LOOKUP) return false;
  let services = 0;
  let keychains = 0;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (PRINT_FLAGS.has(word)) continue;
    if (word === '-s' && rest[i + 1] === KEYCHAIN_SERVICE) { services++; i++; continue; }
    if (word === '-a' && NAME_PATTERN.test(rest[i + 1] ?? '')) { i++; continue; }
    if (KEYCHAIN_FILE.test(word) && ++keychains === 1) continue;
    return false;
  }
  return services === 1;
}

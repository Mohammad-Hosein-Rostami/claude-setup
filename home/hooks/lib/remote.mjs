// Writes to a production host through ssh, scp, rsync, psql or mysql: ask the owner first, even in bypass mode.
// Exports: remoteAsk(cmd, args, assigns, prodHosts) -> reason | undefined; readProdHosts(file?); isProdHost(host, list);
// isReadOnlyRemote(text); isReadOnlySql(sql); PROD_HOSTS_FILE; MAX_PROD_HOSTS_BYTES; EVERY_HOST.
// A host is "production" when its name contains `prod` (always) or matches a line of the private list file
// (~/.claude/private/prod-hosts, one name or `*` glob per line, `#` comments; never committed, see settings/prod-hosts.example).
// Read-only remote commands (cat, ls, tail, grep, systemctl status, docker ps/logs, SELECT, ...) are allowed.
// The list file is read through lib/plain-file.mjs (no waiting, no link followed, a size cap). A file that is there but is not a plain
// file within the cap (a link, FIFO, device, folder, unreadable) cannot be trusted to be the list: then EVERY host counts as production,
// so each ssh, scp, rsync, psql and mysql write asks until the owner puts a plain file back. Only a missing file is an empty list.
// Invariants: pure apart from readProdHosts; a command that cannot be classified as read-only counts as a write (ask,
// never deny); parsing is a heuristic for model mistakes, not a sandbox (an ssh alias that hides the host is not seen).
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandOf } from './command-of.mjs';
import { parseGitArgs } from './git-options.mjs';
import { readPlainFile } from './plain-file.mjs';
import { flagsOf, tokenize } from './shell-words.mjs';
import { isReadOnlySql, sqlHosts, sqlOf } from './sql.mjs';

export { isReadOnlySql };

export const PROD_HOSTS_FILE = join(homedir(), '.claude', 'private', 'prod-hosts');
const PROD_NAME = /prod/i;
const SSH_VALUE_OPTIONS = new Set(['-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w']);
const SCP_VALUE_OPTIONS = new Set(['-P', '-i', '-o', '-F', '-J', '-l', '-S', '-c']);
const RSYNC_VALUE_OPTIONS = new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f', '--port', '--exclude-from', '--include-from',
  '--files-from', '--bwlimit', '--chmod', '--backup-dir', '--suffix', '-M', '-B', '--rsync-path', '--log-file', '--temp-dir', '-T']);
const READ_ONLY_COMMANDS = new Set(['cat', 'ls', 'tail', 'head', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'df', 'du', 'ps', 'uptime', 'whoami',
  'hostname', 'date', 'stat', 'file', 'pwd', 'echo', 'printf', 'id', 'uname', 'free', 'nproc', 'which', 'pgrep', 'ss', 'netstat', 'lsof',
  'printenv', 'test', '[', 'true', 'uniq', 'cut', 'tr', 'less', 'more', 'readlink', 'realpath', 'basename', 'dirname', 'md5sum', 'sha256sum',
  'tree', 'lscpu', 'lsblk', 'zcat', 'xxd', 'jq']);
const SYSTEMCTL_READ = new Set(['status', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'show', 'cat', 'list-timers']);
const DOCKER_READ = new Set(['ps', 'logs', 'inspect', 'images', 'stats', 'top', 'version', 'info', 'port', 'ls']);
const COMPOSE_READ = new Set(['ps', 'logs', 'config', 'top', 'images', 'ls']);
const KUBECTL_READ = new Set(['get', 'describe', 'logs', 'top']);
const GIT_READ = new Set(['log', 'status', 'diff', 'show', 'rev-parse', 'branch', 'remote']);
const FIND_WRITE_FLAGS = /^-(delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;
const OUTPUT_REDIRECT = /^(\d*>>?|&>>?|\d*>\|)(.*)$/;
const DESCRIPTOR_OR_NULL = /^(&\d+|&-|\/dev\/null)$/;
const REMOTE_SPEC = /^(?:[^@/:\s]+@)?(\[[^\]]+\]|[^/:\s@]{2,}):(?!\/\/)/;
const RSYNC_URL = /^rsync:\/\/(?:[^@/]*@)?([^/:]+)/;

/** The most the host list may hold: 64 KB is thousands of names, and a larger file is not a list someone keeps by hand. */
export const MAX_PROD_HOSTS_BYTES = 64 * 1024;
/** The list that stands in for a file that is there but is not a plain file within the cap: the glob that matches every host. */
export const EVERY_HOST = Object.freeze(['*']);
const MISSING_FILE = 'ENOENT';

/**
 * Hosts from the private list file; [] when it is missing (the `prod` name rule still applies); EVERY_HOST when it is there but is a
 * link, a FIFO, a device, a folder, over MAX_PROD_HOSTS_BYTES or unreadable: the guard fails closed and never waits on it.
 * @param {string} [file] defaults to PROD_HOSTS_FILE, overridable by env CLAUDE_PROD_HOSTS_FILE
 * @returns {readonly string[]} lowercase names or globs
 */
export function readProdHosts(file = process.env.CLAUDE_PROD_HOSTS_FILE || PROD_HOSTS_FILE) {
  try {
    return readPlainFile(file, MAX_PROD_HOSTS_BYTES).split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
  } catch (error) {
    return error?.code === MISSING_FILE ? [] : EVERY_HOST;
  }
}

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|\\[\]]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

/** True when `host` (user@ and port already removed) is named like production or listed. Pure. */
export function isProdHost(host, list = []) {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return PROD_NAME.test(name) || list.some((entry) => globToRegExp(entry).test(name));
}

/** Words after the host in an `ssh` call, and the host: skips options and the values of the value options. */
function sshParts(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-') && args[i] !== '--') i += SSH_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
  if (args[i] === '--') i += 1;
  const target = args[i];
  const host = target?.replace(/^ssh:\/\//, '').replace(/^[^@]*@/, '').replace(/[:/].*$/, '');
  return { host, remote: args.slice(i + 1) };
}

/** Positional words (no options, no option values; everything after `--`). */
function positionals(args, valueOptions) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') return [...out, ...args.slice(i + 1)];
    if (!args[i].startsWith('-') || args[i] === '-') out.push(args[i]);
    else if (valueOptions.has(args[i])) i += 1;
  }
  return out;
}

/** Host of an scp/rsync operand (`user@host:path`, `rsync://host/x`, `host::module`), or undefined for a local path. */
const remoteHost = (word) => RSYNC_URL.exec(word)?.[1] ?? REMOTE_SPEC.exec(word)?.[1];

const writesFile = (tokens) =>
  tokens.some((t, i) => {
    const m = OUTPUT_REDIRECT.exec(t);
    return m !== null && !DESCRIPTOR_OR_NULL.test(m[2] || tokens[i + 1] || '');
  });

function isReadOnlyCommand({ cmd, args }) {
  const flags = flagsOf(args);
  const [first, second] = args.filter((a) => !a.startsWith('-'));
  if (cmd === undefined) return true; // an assignment alone runs nothing
  if (cmd === 'sort') return !flags.some((f) => /^-[a-zA-Z]*o|^--output/.test(f));
  if (cmd === 'find') return !flags.some((f) => FIND_WRITE_FLAGS.test(f));
  if (cmd === 'sed') return !flags.some((f) => /^-[a-zA-Z]*i|^--in-place/.test(f));
  if (cmd === 'systemctl') return SYSTEMCTL_READ.has(first);
  if (cmd === 'journalctl') return !flags.some((f) => /^--(vacuum|rotate|flush|relinquish|sync)/.test(f));
  if (cmd === 'docker') return first === 'compose' ? COMPOSE_READ.has(second) : DOCKER_READ.has(first);
  if (cmd === 'docker-compose') return COMPOSE_READ.has(first);
  if (cmd === 'kubectl') return KUBECTL_READ.has(first);
  // the first word that is no option is a read verb (an option value never counts: `git -C /srv status` is a write), and so is every
  // subcommand git may run (lib/git-options.mjs): `git -C log reset --hard` runs reset
  if (cmd === 'git') return GIT_READ.has(first) && parseGitArgs(args).subcommands.every(({ sub }) => GIT_READ.has(sub));
  if (cmd === 'psql' || cmd === 'mysql') return isReadOnlySql(sqlOf(cmd, args));
  return READ_ONLY_COMMANDS.has(cmd);
}

/**
 * True when every command in the remote command text is on the read-only list and nothing is redirected to a file.
 * Empty text (an interactive login or a tunnel) is not read-only.
 * @param {string} text what the remote shell would run
 */
export function isReadOnlyRemote(text) {
  const { segs, nested } = tokenize(text);
  if (segs.length === 0) return false;
  const plain = segs.every((seg) => !writesFile(seg) && isReadOnlyCommand(commandOf(seg)));
  return plain && nested.every(isReadOnlyRemote);
}

const askFor = (what, host) => `${what} ${host}, a production host; confirm with the owner (list: ~/.claude/private/prod-hosts)`;

function copyAsk(cmd, args, prodHosts) {
  const valueOptions = cmd === 'scp' ? SCP_VALUE_OPTIONS : RSYNC_VALUE_OPTIONS;
  const words = positionals(args, valueOptions);
  const destination = remoteHost(words.at(-1) ?? '');
  if (destination !== undefined && isProdHost(destination, prodHosts)) return askFor(`${cmd} uploads to`, destination);
  const deletesSource = cmd === 'rsync' && args.includes('--remove-source-files');
  const source = words.slice(0, -1).map(remoteHost).find((h) => h !== undefined && isProdHost(h, prodHosts));
  return deletesSource && source !== undefined ? askFor('rsync --remove-source-files deletes files on', source) : undefined;
}

/**
 * Reason to ask the owner when this command may write to a production host, else undefined.
 * @param {string} cmd command name (`ssh`, `scp`, `rsync`, `psql`, `mysql`; anything else gives undefined)
 * @param {string[]} args words after the command
 * @param {string[]} assigns `VAR=x` words before the command (PGHOST)
 * @param {string[]} prodHosts entries of the private list
 */
export function remoteAsk(cmd, args, assigns, prodHosts) {
  if (cmd === 'scp' || cmd === 'rsync') return copyAsk(cmd, args, prodHosts);
  if (cmd === 'ssh') {
    const { host, remote } = sshParts(args);
    if (host === undefined || !isProdHost(host, prodHosts) || isReadOnlyRemote(remote.join(' '))) return undefined;
    return askFor('ssh may change', host);
  }
  if (cmd === 'psql' || cmd === 'mysql') {
    const host = sqlHosts(args, assigns).find((h) => isProdHost(h, prodHosts));
    if (host === undefined || isReadOnlySql(sqlOf(cmd, args))) return undefined;
    return askFor(`${cmd} may write to`, host);
  }
  return undefined;
}

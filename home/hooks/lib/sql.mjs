// SQL on the command line of psql/mysql: is it read-only, and which host does the call connect to.
// Exports: isReadOnlySql(sql), sqlOf(cmd, args), sqlHosts(args, assigns).
// Read-only is decided per statement: a statement counts as a read only when it STARTS with select/show/explain/describe/
// with...select/values/table or a psql `\d...`/`\l` listing AND contains none of the write-like words (INTO, COPY, DO, CALL,
// ALTER/DROP/INSERT/UPDATE/DELETE/TRUNCATE/GRANT/REVOKE/CREATE/MERGE, setval/nextval, pg_terminate_backend/pg_cancel_backend/
// pg_drop_*/pg_create_*/pg_reload_conf, lo_*, dblink*, set_config, ...) and no active psql meta command (`\!`, `\g`, `\i`, `\copy`).
// String literals, quoted identifiers and comments are removed first, so `select 'update'` is still a read. Anything else on a
// production host asks. Hosts come from -h/--host/-hHOST, URLs, conninfo strings (also behind -d/--dbname), PGHOST/MYSQL_HOST.
// Pure, no I/O. Invariant: a statement that cannot be classified is not read-only (ask, never deny).

const READ_START = /^(?:select|show|explain|describe|desc|values|table|with\b[\s\S]*\bselect|\\d[a-zA-Z+]*|\\l(?:ist)?\+?)(?=\s|$|\(|\\)/i;
const WRITE_WORDS = /\b(?:into|copy|do|call|alter|drop|insert|update|delete|truncate|grant|revoke|create|merge|vacuum|reindex|refresh|cluster|program|system|execute|prepare|outfile|dumpfile|setval|nextval|set_config|pg_terminate_backend|pg_cancel_backend|pg_drop\w*|pg_create\w*|pg_reload_conf|pg_rotate_logfile|pg_switch_wal\w*|pg_stat_reset\w*|pg_advisory_\w+|lo_\w+|dblink\w*)\b/i;
// psql meta commands that write or run something: `\!` shell, `\o` `\w` `\g` `\gexec` output, `\i` `\ir` `\e` `\ef` `\ev` scripts/editors, `\lo_*`, `\copy`
const ACTIVE_META = /\\(?:!|ir?\b|o\b|g|w\b|ef?\b|ev\b|lo_|copy|set\b|c\b|connect)/i;
const STRING_OR_COMMENT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//g;
const STATEMENT_BREAK = /;|\n(?=\s*\\)/;

const SQL_URL = /^(?:postgres(?:ql)?|mysql):\/\/(.*)$/i;
const URL_AUTHORITY_HOST = /^(\[[^\]]+\]|[^:/?#\s]+)/;
const CONNINFO_HOST = /(?:^|\s)host(?:addr)?\s*=\s*'?([^\s']+)/gi;
const URL_QUERY_HOST = /[?&]host=([^&\s]+)/gi;
const DBNAME_OPTION = /^(?:--dbname=|-d)/;

function isReadStatement(statement) {
  const text = statement.trim();
  if (text === '') return true; // an empty statement (`select 1;`) runs nothing
  return READ_START.test(text) && !WRITE_WORDS.test(text) && !ACTIVE_META.test(text);
}

/**
 * @param {string | string[] | null | undefined} sql one text, or all the `-c`/`-e` texts of one call (every one must be a read)
 * @returns {boolean} true only for non-empty text whose statements are all reads; null (`-f file`, stdin) is not
 */
export function isReadOnlySql(sql) {
  if (Array.isArray(sql)) return sql.length > 0 && sql.every(isReadOnlySql);
  if (typeof sql !== 'string' || sql.trim() === '') return false;
  const stripped = sql.replace(STRING_OR_COMMENT, ' ');
  return stripped.split(STATEMENT_BREAK).every(isReadStatement);
}

/** Every SQL text given on the command line (each `-c`/`--command`, `-e`/`--execute`, attached or separate), or null when there is none or a script file is also run. */
export function sqlOf(cmd, args) {
  const [short, long] = cmd === 'psql' ? ['-c', '--command'] : ['-e', '--execute'];
  const found = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--file' || a.startsWith('--file=')) return null;
    if (a === short || a === long) found.push(args[++i] ?? '');
    else if (a.startsWith(`${long}=`)) found.push(a.slice(long.length + 1));
    else if (a.startsWith(short) && !a.startsWith('--') && a.length > 2 && cmd === 'psql') found.push(a.slice(2));
  }
  return found.length > 0 ? found : null;
}

/** Hosts a connection string names: URL authority (read both after the first and after the LAST `@`, so a password with `@` or `/` cannot hide it), `?host=`, `host=` pairs. */
function hostsInConnection(text) {
  const hosts = [];
  const url = SQL_URL.exec(text)?.[1];
  if (url !== undefined) {
    for (const rest of [url, url.slice(url.indexOf('@') + 1), url.slice(url.lastIndexOf('@') + 1)]) hosts.push(URL_AUTHORITY_HOST.exec(rest)?.[1]);
    hosts.push(...[...url.matchAll(URL_QUERY_HOST)].map((m) => m[1]));
  }
  hosts.push(...[...text.matchAll(CONNINFO_HOST)].map((m) => m[1]));
  return hosts.filter(Boolean);
}

/**
 * Every host a psql/mysql call may connect to: `-h`, `--host`, `-hHOST`, a URL or conninfo string (as a positional word or behind
 * `-d`/`--dbname`), PGHOST/MYSQL_HOST. Empty for the local default. The caller asks when any of them is a production host.
 * @param {string[]} args words after the command
 * @param {string[]} assigns `VAR=x` words before the command
 */
export function sqlHosts(args, assigns) {
  const hosts = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--host') hosts.push(args[i + 1]);
    else if (a.startsWith('--host=')) hosts.push(a.slice('--host='.length));
    else if (/^-h[^-]/.test(a)) hosts.push(a.slice(2));
    else hosts.push(...hostsInConnection(a.replace(DBNAME_OPTION, '')));
  }
  hosts.push(...assigns.map((w) => /^(?:PGHOST|MYSQL_HOST)=(.+)$/.exec(w)?.[1]));
  return hosts.filter(Boolean);
}

// SQL on the command line of psql/mysql: is it read-only, and which host does the call connect to.
// Exports: isReadOnlySql(sql), sqlOf(cmd, args), sqlHosts(args, assigns).
// Read-only is decided per statement: a statement counts as a read only when it STARTS with select/show/explain/describe/
// with...select/values/table or a psql `\d...`/`\l` listing AND contains none of the write-like words (INTO, COPY, DO, CALL,
// ALTER/DROP/INSERT/UPDATE/DELETE/TRUNCATE/GRANT/REVOKE/CREATE/MERGE, setval/nextval, pg_terminate_backend/pg_cancel_backend/
// pg_drop_*/pg_create_*/pg_reload_conf, lo_*, dblink*, set_config, ...), no function call outside a list of plain read functions (count,
// now, version, current_*, ...; so `pg_promote()` and `query_to_xml('delete ...')` ask), and no active psql meta command (`\!`, `\g`, `\i`, `\copy`).
// String literals, quoted identifiers and comments are removed first, so `select 'update'` is still a read. Anything else on a
// production host asks. Hosts come from -h/--host/-hHOST, URLs, conninfo strings (also behind -d/--dbname), PGHOST/PGSERVICE/MYSQL_HOST (a service name such as `prod` counts as a host name).
// Pure, no I/O. Invariant: a statement that cannot be classified is not read-only (ask, never deny).

const READ_START = /^(?:select|show|explain|describe|desc|values|table|with\b[\s\S]*\bselect|\\d[a-zA-Z+]*|\\l(?:ist)?\+?)(?=\s|$|\(|\\)/i;
const WRITE_WORDS = /\b(?:into|copy|do|call|alter|drop|insert|update|delete|truncate|grant|revoke|create|merge|vacuum|reindex|refresh|cluster|program|system|execute|prepare|outfile|dumpfile|setval|nextval|set_config|pg_terminate_backend|pg_cancel_backend|pg_drop\w*|pg_create\w*|pg_reload_conf|pg_rotate_logfile|pg_switch_wal\w*|pg_stat_reset\w*|pg_advisory_\w+|lo_\w+|dblink\w*)\b/i;
// psql meta commands that write or run something: `\!` shell, `\o` `\w` `\g` `\gexec` output, `\i` `\ir` `\e` `\ef` `\ev` scripts/editors, `\lo_*`, `\copy`
const ACTIVE_META = /\\(?:!|ir?\b|o\b|g|w\b|ef?\b|ev\b|lo_|copy|set\b|c\b|connect)/i;
const STRING_OR_COMMENT = /'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//g;
// Any function call is a possible write (`pg_promote()`, `query_to_xml('delete ...')`, `pg_file_write`, `sleep`, `load_file`): only these
// plain read functions and the SQL words that are followed by a parenthesis without being calls are allowed.
const FUNCTION_CALL = /([A-Za-z_][\w$]*)\s*\(/g;
const QUOTED_NAME_CALL = /"(?:[^"]|"")*"\s*\(/; // `"pg_promote"()`: the name is stripped with the string literals, so look for it first
const PLAIN_READ_FUNCTIONS = new RegExp(`^(?:${[
  'count', 'sum', 'avg', 'min', 'max', 'now', 'version', 'coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'length', 'char_length', 'substr', 'substring',
  'trim', 'ltrim', 'rtrim', 'concat', 'concat_ws', 'replace', 'round', 'floor', 'ceil', 'ceiling', 'abs', 'mod', 'date_trunc', 'date_part', 'extract', 'to_char',
  'to_date', 'to_timestamp', 'cast', 'array_agg', 'string_agg', 'json_agg', 'jsonb_agg', 'json_build_object', 'jsonb_build_object', 'row_number', 'rank',
  'dense_rank', 'lag', 'lead', 'first_value', 'last_value', 'generate_series', 'unnest', 'array_length', 'cardinality', 'age', 'date', 'timestamp', 'to_json',
  'to_jsonb', 'regexp_replace', 'split_part', 'left', 'right', 'position', 'strpos', 'md5', 'ifnull', 'if', 'date_format', 'database', 'schema', 'user',
  'pg_size_pretty', 'pg_database_size', 'pg_total_relation_size', 'pg_relation_size', 'pg_table_size', 'pg_indexes_size', 'current_\\w+',
  // SQL words that take a parenthesis but are not calls
  'in', 'values', 'as', 'and', 'or', 'not', 'on', 'using', 'where', 'from', 'join', 'over', 'partition', 'filter', 'select', 'exists', 'any', 'all', 'some',
  'limit', 'offset', 'array', 'row', 'case', 'when', 'then', 'else', 'between', 'like', 'ilike', 'table', 'lateral', 'with', 'union', 'intersect', 'except',
  'by', 'having', 'group', 'order', 'distinct', 'interval', 'recursive', 'materialized', 'explain', 'analyze', 'verbose', 'show', 'describe', 'desc',
].join('|')})$`, 'i');
const STATEMENT_BREAK = /;|\n(?=\s*\\)/;

const SQL_URL = /^(?:postgres(?:ql)?|mysql):\/\/(.*)$/i;
const URL_AUTHORITY_HOST = /^(\[[^\]]+\]|[^:/?#\s]+)/;
const CONNINFO_HOST = /(?:^|\s)(?:host(?:addr)?|service)\s*=\s*'?([^\s']+)/gi;
const URL_QUERY_HOST = /[?&]host=([^&\s]+)/gi;
const DBNAME_OPTION = /^(?:--dbname=|-d)/;

const callsOnlyReadFunctions = (text) => [...text.matchAll(FUNCTION_CALL)].every((m) => PLAIN_READ_FUNCTIONS.test(m[1]));

function isReadStatement(statement) {
  const text = statement.trim();
  if (text === '') return true; // an empty statement (`select 1;`) runs nothing
  return READ_START.test(text) && !WRITE_WORDS.test(text) && !ACTIVE_META.test(text) && callsOnlyReadFunctions(text);
}

/**
 * @param {string | string[] | null | undefined} sql one text, or all the `-c`/`-e` texts of one call (every one must be a read)
 * @returns {boolean} true only for non-empty text whose statements are all reads; null (`-f file`, stdin) is not
 */
export function isReadOnlySql(sql) {
  if (Array.isArray(sql)) return sql.length > 0 && sql.every(isReadOnlySql);
  if (typeof sql !== 'string' || sql.trim() === '') return false;
  if (QUOTED_NAME_CALL.test(sql)) return false;
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
 * `-d`/`--dbname`), PGHOST/PGSERVICE/MYSQL_HOST (a service name such as `prod` counts as a host name). Empty for the local default. The caller asks when any of them is a production host.
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
  hosts.push(...assigns.map((w) => /^(?:PGHOST|PGHOSTADDR|PGSERVICE|MYSQL_HOST)=(.+)$/.exec(w)?.[1]));
  return hosts.filter(Boolean);
}

// Literal secrets typed into a Bash command. Exports: findLiteralSecret(command) -> string | undefined; maskSecrets(command) -> string;
// maskSecretFields(toolInput) -> masked JSON (secret-named fields of any tool input, then maskSecrets);
// literalSecretValues(command) -> string[] (the raw values, for lib/allowed-literals.mjs, which only hashes them; never log or print them).
// Returns only a KIND label ("an Anthropic API key", ...), never the secret itself: the caller prints it in a deny message.
// Detected: sk-ant-..., ghp_/gho_/ghu_/ghs_/ghr_/github_pat_ tokens, AWS access key ids, `--password=x` / `--password x`,
// `sshpass -p x`, `mysql -pX`, `docker login -p x`, PGPASSWORD / MYSQL_PWD / AWS_SECRET_ACCESS_KEY assigned a literal, any
// `*_KEY=` / `*_TOKEN=` / `*_SECRET=` / `*PASSWORD=` assigned a literal, sk-proj- / glpat- / xoxb- / xoxp- tokens, `Bearer x`
// (so `Authorization: Bearer x` too), `-u user:pass` / `--user user:pass`, and URL credentials `scheme://user:pass@host`.
// A value that starts with `$` (variable, `$(cat file)`), a backtick or `<(` is not literal; nor, for a generic `*_KEY=` style name, one that starts like a path (`/`, `./`, `../`, `~/`). Scans the raw text, so quotes,
// heredocs and `bash -c '...'` are all covered. A noisy false positive is accepted: the check is meant to be strict (the hook turns a hit into a timed ask).
// Data text is the one exemption (lib/data-text.mjs dataTextRemoved): the body of a quoted-delimiter heredoc that a bare cat or tee stores
// (`cat > f <<'EOF'`) where nothing else in the command can run or read it, and a single-quoted argument of a program that never runs it
// (lib/inert-arguments.mjs: `grep -n '...' f`), are not read by the context rules (an assignment, `Bearer x`, a header, a URL or query credential,
// a flag), whose hits there are program code. A known token shape (TOKEN_KINDS), a named secret variable (PGPASSWORD=...) and an env-file
// assignment line (`API_TOKEN=x`, `export DB_PASSWORD=x`) are still found in data, so a real one written into a file asks. A body that runs
// (`bash <<'EOF'`, `cat <<'EOF' | sh`, `cat > x.sh <<'EOF'` then `bash x.sh`, inside `$(...)` or `{ } | sh`), an unquoted `<<EOF` body and any
// line that reader cannot pair the way the shell does are scanned whole. maskSecrets and literalSecretValues read data text too.
// Also: a literal given on stdin to a `--with-token` / `--password-stdin` command: `gh auth login --with-token <<< T`, `echo T | docker login
// --password-stdin` (`echo`/`printf` input; `$VAR` and `$(...)` input is not literal).
// Also: SSHPASS=, `vault login <token>`, `--from-literal=<k>=<v>` (k names a pass/secret/token/key), `az ... -p`, `htpasswd -b`,
// `aws configure set *secret* <v>`.
// Linear time (Round 4): every pattern is anchored at a rare literal and every gap between a prefix and its value is a BOUNDED repeat
// of disjoint alternatives (no unbounded nested or overlapping quantifier), so the cost is input length x a small constant. Input beyond
// MAX_SCAN_CHARS is not scanned (the hook asks about a command that long before it gets here); maskSecrets cuts it and says so.

import { MIN_VALUE_LENGTH } from './allowed-literals.mjs';
import { dataTextRemoved } from './data-text.mjs';

const TOKEN_KINDS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, 'a GitHub token'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/\bsk-proj-[A-Za-z0-9_-]{10,}/, 'an OpenAI API key'],
  [/\bglpat-[A-Za-z0-9_-]{10,}/, 'a GitLab token'],
  [/\bxox[bp]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
];
const MAX_SCAN_CHARS = 32 * 1024;
const GAP = 300; // longest stretch between a command word and its flag that is still looked at
const NAME_MAX = 80; // longest variable, header or scheme name that is still looked at
const SECRET_ENV = '(?:PGPASSWORD|MYSQL_PWD|AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|SSHPASS)';
const NOT_LITERAL_START = '(?!["\']?(?:\\$|`|<|\\s|;|&|\\||$))';
const VALUE = `["']?[^\\s"';&|]`;
// What the masker hides after a prefix: a whole quoted string or one unquoted word.
const VALUE_RUN = `"[^"]*"|'[^']*'|[^\\s"';&|]+`;
// [prefix, extra lookahead, kind, options]: the prefix ends right before the value, so one table drives both detection and
// masking. options.value replaces the detected/masked value pattern, options.flags are the regex flags (e.g. 'i'), options.start replaces NOT_LITERAL_START.
const BOUNDARY = `(?:^|[\\s;&|("'])`;
// URL userinfo: the password runs to the LAST `@` of the word, so one containing `@` or `/` is still covered. A `:port/@scope`
// (`http://localhost:5173/@vite/client`) is not a password: digits followed by `/ ? #` or the end are a port.
const URL_PASSWORD = '[^\\s"\']{0,500}(?=@)';
const URL_NOT_A_PORT = '(?!\\d+(?:[/?#"\'\\s]|$))';
// curl-family commands, quote-aware so `-H "X: a;b"` does not end the command early; `-u user:pass` is only a credential for these
const HTTP_TOOL = `\\b(?:curl|wget|http|https|xh|hurl)\\b(?:"[^"\\n]{0,${GAP}}"|'[^'\\n]{0,${GAP}}'|[^\\n|;&"']){0,${GAP}}?`;
// A header value is a literal unless it contains a variable, a substitution or a placeholder (`Bearer $TOKEN`, `Bearer <token>`).
const HEADER_VALUE = `(?![^"'\\n]{0,500}[$\`<])[^"'\\n]{1,500}`;
// `Authorization`, `Proxy-Authorization`, any hyphenated `...-Key/-Token/-Secret` name (`X-Api-Key`, `PRIVATE-TOKEN`), `Cookie`
// Spelled with `caseless` (no 'i' flag) so FORMAT_PLACEHOLDER below can test for lowercase.
const caseless = (letters) => letters.replace(/[a-z]/gi, (char) => `[${char.toLowerCase()}${char.toUpperCase()}]`);
const HEADER_NAME = `(?:(?:${caseless('Proxy-')})?${caseless('Authorization')}|[A-Za-z0-9]{1,${NAME_MAX}}-[\\w-]{0,${NAME_MAX}}(?:${caseless('key|token|secret')})|${caseless('Cookie')})`;
// A header value that is only a printf/format placeholder (`%v %+v %s %q %5.2f`, `%(name)s`, `{}` `{0}` `{name}`) up to the closing quote or line end
// is a format string in program text (`t.Errorf("bad cookie: %+v", c)`), not a credential. A verb glued to more text (`%s3cr3t`) is still a value,
// and a brace or `%(...)s` name only counts when it is a short lowercase identifier (`{R}` / `%(R)s` with R a token is a value).
const PLACEHOLDER_NAME = '[a-z_][a-z0-9_]{0,19}';
const PLACEHOLDER_SPEC = '[<>^=+ #0-9.,_a-z%-]{0,10}';
const PLACEHOLDER = `(?:%[-+# 0]{0,5}(?:\\d{1,3}|\\*)?(?:\\.(?:\\d{1,3}|\\*))?[a-zA-Z]|%\\(${PLACEHOLDER_NAME}\\)[-+# 0]{0,5}\\d{0,3}[a-zA-Z]|\\{(?:\\d{1,2}|${PLACEHOLDER_NAME})?(?::${PLACEHOLDER_SPEC})?\\})`;
// It ends at the quote that opened the header string (`\k<q>`, found by looking back) or at the line end when unquoted: `"X: %s'R'"` is not a placeholder.
// What looks back is a real opener: it follows whitespace or an opening bracket (not the `*`/`}` that ends `"Accept: */*"` or `'{}'`), and the text
// between it and the name holds no shell flag (` -H `), so a quote that closed an earlier argument is never taken for this header's opener.
// After the closing quote only a real boundary may follow (closing brackets, then whitespace, `;&|`, `,` plus whitespace, or the end): `-H "X: %s"R` is a value.
const AFTER_QUOTE = '(?=[)}\\]]{0,4}(?:[\\s;&|]|,\\s|$))';
const OPENER = '(?<=^|[\\s(=,\\[{:])';
// A TypeScript type annotation (`cookie: string`, `cookie: string | null;`, `x-api-key: string[]`) names a type, not a value: a primitive type word (or a `|` union of them, with `[]`) that ends at `; , } )`, a quote, `=` or the line end.
// It is the WHOLE value, never a prefix: what ends it must end the header too (`; ,` then a blank, a closing bracket or quote then a boundary, ` =`),
// and no `name=value` may follow on the line (`Cookie: undefined=x; session=R`, `X-Api-Key: string,R` and `any"R` are values).
const TS_TYPE_WORD = '(?:string|number|boolean|bigint|symbol|object|unknown|any|never|void|null|undefined)(?:\\[\\])?';
const TS_TYPE = `(?![^\\n"']{0,500}[\\w-]=[^\\s=])${TS_TYPE_WORD}(?:[ \\t]*\\|[ \\t]*${TS_TYPE_WORD}){0,6}[ \\t]*(?:[;,](?=\\s|$)|[})\\]](?=[\\s;,)}\\]]|$)|(?<=[ \\t])=|["'](?=[\\s;,)}\\]]|$)|\\n|$)`;
const FORMAT_PLACEHOLDER = `(?!(?<=${OPENER}(?<q>["'])(?:(?!\\s--?[A-Za-z])[^"'\\n]){0,500})${PLACEHOLDER}[ \\t]*\\k<q>${AFTER_QUOTE}|${PLACEHOLDER}[ \\t]*(?:\\n|$)|${TS_TYPE})`;
// 12 lowercase letters at most that END the word: punctuation or a closing quote may follow, then a blank or the end. A token head glued to
// more text (a slash, plus, dot or colon, then the rest of the token) is not prose.
const BEARER_PROSE_WORD = '[a-z]{1,12}(?=[.,;:!?"\')\\]]*(?:\\s|$))';
const STDIN_FLAG = '--(?:with-token|password-stdin)\\b';
// the value is echoed/printed (`echo -n T`, `printf '%s' T`) and piped into a command that has the stdin flag
const ECHOED_INTO_STDIN_FLAG = `(?=(?:"[^"]*"|'[^']*'|[^\\s"';&|]+)[ \\t]*\\|[^\\n;&|]{0,${GAP}}${STDIN_FLAG})`;
// A value that looks like a path or a regex held in a variable is not a literal: `./x`, `../x`, `~/x`; a `/x|y/` regex (`STATE_KEY=/state|hover/`);
// `/x` under a common absolute root (`KEY_PATH=/Users/x/k.pem`). A bare leading `/` is not enough: about 1 in 64 base64 keys starts with one.
const ABSOLUTE_ROOTS = 'Users|home|tmp|private|var|etc|opt|usr|Volumes';
// a regex value has its `|` inside the value: in its own quotes, or unquoted and closed by a `/` plus JS flags (`/a|b/i;`; else `KEY=/<b64>|tee` would pass)
const REGEX_VALUE = `"/[^"\\n]{0,500}\\|[^"\\n]{0,500}"|'/[^'\\n]{0,500}\\|[^'\\n]{0,500}'|/[^\\s"';&|]{0,500}\\|[^\\s"';&]{0,500}/[dgimsuvy]{0,8}(?![^\\s;&|),])`;
// A template expression that reads something (`{{t .L "x"}}`, `{{ .Password }}`, `{{ user.password }}`, `{{ pw | e }}`, `{% .x %}`): it opens with `.` or an
// identifier followed by `.`, `|` or an argument, and is closed. `{{R}}`, `{{ R }}` and `{{ "R" }}` hold a literal, so they are not exempt.
const TEMPLATE_EXPRESSION = `(?:\\{\\{-?|\\{%-?)[ \\t]{0,5}(?:\\.|[A-Za-z_]\\w{0,39}(?:\\.|[ \\t]{0,5}\\||[ \\t]{1,5}(?![ \\t}%-])))[^{}\\n]{0,200}(?:\\}\\}|%\\})`;
// It must end the value: its own closing quote (when one opened it) and then whitespace, `;&|)>` or the end (`"{{.x}}"R` is a value).
const TEMPLATE_VALUE = `(?:\\\\?(?<tq>["'])${TEMPLATE_EXPRESSION}\\\\?\\k<tq>|${TEMPLATE_EXPRESSION})(?=[\\s;&|)>]|$)`;
// A boolean, null or one- or two-digit flag value (`passwordReset=1`, `password=true`) ends at whitespace, a quote or a shell separator; no real secret is `true` or `1`.
// It is the WHOLE value, never a prefix: a closing quote only matches the opening one, glued brackets or commas must be followed by a boundary
// (`=12,R`, `=null]R`, `"12 R"` are values), and a field inside a quoted string (`-d "password=12 R"`) is never exempt.
const FLAG_VALUE = `(?<!["'][\\w.-]{0,80}=)(?<fq>["']?)(?:true|false|null|undefined|\\d{1,2})\\k<fq>(?=[)}\\],]{0,4}(?:[\\s;&|]|$))`;
const CODE_VALUE = `(?!${REGEX_VALUE}|${FLAG_VALUE}|${TEMPLATE_VALUE}|["']?(?:(?:\\.{1,2}|~)/|/(?:${ABSOLUTE_ROOTS})/)|[=>(\\[]|\\{(?!\\{)|[\\w$]{1,40}\\s*=>|lambda\\b|[\\w$]{1,40}(?:\\.[\\w$]{1,40}){0,6}\\s*[(\\[])`;
const QUERY_TOKEN_KEYS = caseless('api[_-]?key|access[_-]?(?:token|key)|auth[_-]?token|token');
const QUERY_SECRET_KEYS = caseless('client[_-]?secret|secret|password|passwd|pwd');
// What may follow the end of a quoted or bracketed query value: closing brackets, then whitespace, `;`, the end, or a `,` that is followed by whitespace or by the
// next list item: a whole quoted path or URL that is itself followed by `,` `]` or `}` (`['/a?token=x-y','/b']`, never a lone `,"/R"`). Glued text (`"/R`, `".R`,
// `)R`, `]R`, `,R`, `,'R'`) means the value goes on.
const LIST_ITEM = '[ \\t]*(?:"(?:/|https?://)[^"\\n]{0,200}"|\'(?:/|https?://)[^\'\\n]{0,200}\'|`(?:/|https?://)[^`\\n]{0,200}`)[ \\t]*[,\\]}]';
// A list item only counts inside a real list: the quoted string that holds the value must itself open right after `[`, `(`, `{` or `,` (`['/a?token=x-y','/b']`),
// never after a shell word (`curl "https://x/?token=a-b","/R",x` is one argument list for the shell).
const QUOTED_BEFORE = '(?:"[^"\\n]{0,300}"|\'[^\'\\n]{0,300}\'|`[^`\\n]{0,300}`)';
const IN_CODE_LIST = `(?<=[\\[({,]\\s*${QUOTED_BEFORE})`;
// Likewise a `+` after the quote is JS concatenation only when the string opens after `[ ( { , + :` or `= ` with a space (`x = "u?token=a-b"+s`, not shell `x="..."+R`).
const IN_CODE_CONCAT = `(?<=(?:[\\[({,+:][ \\t]*|=[ \\t]+)${QUOTED_BEFORE})`;
const QUERY_END = `(?=[)}\\]]{0,4}(?:[\\s;]|,\\s|$)|${IN_CODE_LIST}[)}\\]]{0,4},${LIST_ITEM})`;
// A value under MIN_VALUE_LENGTH characters is a test fixture (`token=t`), not a secret: the allow-list never remembers one either. It counts the whole shell
// word, skipping quote characters and stopping only at `&`, `#` or whitespace, so `"?token=ab"'R'`, `abcd|R` and a backslash-newline continuation are long enough.
const QUERY_MIN_LENGTH = `(?=(?:(?:["']|\\\\\\r?\\n)*[^\\s"'&#]){${MIN_VALUE_LENGTH}})`;
// A query value that is code, not a literal: empty and closed by a quote then `} )` or a `+` that is not followed by a quoted literal
// (`"/reset?token="+token`, not `+"R"`); a `$(...)`, `$x` or `${name}` / `${name:-}` reference, but not `${name:-R}` (a literal default).
const QUERY_CODE = `["'\`][ \\t]*(?:\\+(?![ \\t]*["'\`])|[})]${QUERY_END})|["']?\\$(?:\\(|\\w|\\{[\\w.]{1,80}(?::?[-=+?])?\\})`;
// `$` is judged by QUERY_CODE here, so the query rules do not use NOT_LITERAL_START (which skips every `$` value).
const QUERY_START = '(?!["\']?(?:`|<|\\s|;|&|\\||$))';
// A kebab-case mock word (`token=verify-ok`): lowercase (these rules have no 'i' flag), 24 chars at most, one hyphen at least, and it ENDS the
// value: a quote not followed by more value, whitespace, `&`, `#`, `)` or the end. Only for token-like keys, never password/secret keys.
// It also ends at a backtick that closes a JS template literal (then a blank, a closer, or a method call such as `.replace(`) and at `${...}` parts
// that END the value (`mock-token-${id}`): a token glued after them is not a mock word.
const MOCK_WORD_ENDS_IN_TEMPLATE = '`(?=[)}\\]\\s;,]|\\.[A-Za-z_]\\w{0,20}\\(|$)|(?:-?\\$\\{[\\w.]{1,40}\\})+(?=[`"\'&#)\\s]|$)';
const QUERY_MOCK_WORD = `(?=[a-z-]{1,24}(?![\\w-]))[a-z]+(?:-[a-z]+)+(?:["'](?:${QUERY_END}|${IN_CODE_CONCAT}[ \\t]*\\+(?![ \\t]*["'\`]))|\\)${QUERY_END}|${MOCK_WORD_ENDS_IN_TEMPLATE}|[\\s&#]|$)`;
const QUERY_NOT_LITERAL = `${QUERY_MIN_LENGTH}(?!${QUERY_CODE})`;
const QUERY_TOKEN_NOT_LITERAL = `${QUERY_MIN_LENGTH}(?!${QUERY_CODE}|${QUERY_MOCK_WORD})`;
// The flag is its own shell word: it follows the start, whitespace, a command separator, `(`, a quote, a backslash, `,` or `{` (`{,--token} R` is brace expansion).  `.card--password` and `staff--password (12 px)`
// (BEM modifiers, state ids) are not flags. A value that is only a code opener or an ellipsis (`{`, `(`, `[`, `...`, `…`) is not a value either; other punctuation (`%+=:,.~@#`) or a quoted one still is.
const SECRET_FLAG = '(?<=^|[\\s;&|(`"\'\\\\,{])--(?:token|api-key|apikey|password|passwd|client-secret|access-token|auth-token)(?:=|\\}?\\s+)';
const PUNCTUATION_ONLY_WORD = '(?:[{(\\[]|\\.{3}|…)(?:[\\s;&|]|$)';
// Names with a KEY or TOKEN part but no password/secret part: for these a value holding a character outside a token charset (`…).slice(0,`) is code or text.
// Password and secret names keep the broad rule, since a password may hold any character.
const PASSWORD_NAME_PART = '(?<![A-Za-z0-9])(?:SECRET|PASS|PASSWD|PWD)(?![A-Za-z0-9])|PASSWORD';
const TOKEN_NAME_PART = '(?<![A-Za-z0-9])(?:KEY|TOKEN)(?![A-Za-z0-9])';
const TOKEN_CHARS = 'A-Za-z0-9._~+/=:-';
// Only CODE shapes are exempt: token characters then `(` or `[` (a call, an index), or an ellipsis. One stray character after a real token (`R)`, `R,`, `R!`) is not.
const NOT_A_TOKEN_VALUE = `["']?[${TOKEN_CHARS}]*(?:[(\\[]|…)`;
const VALUE_KINDS = [
  // a named secret variable is a secret wherever it stands, data text included (see dataTextRemoved)
  [`(?:^|[\\s;&|("'])${SECRET_ENV}=`, '', 'a password or key assigned in the command', { inData: true }],
  [SECRET_FLAG, `(?!-|${PUNCTUATION_ONLY_WORD})`, 'a password, token or key flag with a literal value'],
  [`${STDIN_FLAG}[^\\n|;&<]{0,${GAP}}?<<<[ \\t]*`, '', 'a token or password given as a here-string'],
  [`\\b(?:echo|printf)\\b[ \\t]+(?:-[a-zA-Z]+[ \\t]+){0,3}(?:(?:"%s(?:\\\\n)?"|'%s(?:\\\\n)?'|%s)[ \\t]+)?`, ECHOED_INTO_STDIN_FLAG, 'a token or password piped to a stdin flag'],
  ['\\bsshpass\\s+(?:-\\w*\\s+){0,10}-p\\s*', '', 'an sshpass password'],
  [`\\b(?:mysql|mysqladmin|mysqldump|mariadb)\\b[^\\n|;&]{0,${GAP}}?\\s-p`, '', 'a mysql password flag with a literal value'],
  [`\\bdocker\\s+login\\b[^\\n|;&]{0,${GAP}}?\\s-p\\s+`, '', 'a docker login password'],
  [`\\bvault\\s+login\\s+(?:-[\\w-]+(?:=\\S*)?\\s+){0,6}`, '(?![^\\s"\']*=)', 'a vault token'],
  [`\\bvault\\s+login\\b[^\\n|;&]{0,${GAP}}?\\spassword=`, '', 'a vault password'],
  [`--from-literal(?:=|\\s+)[\\w.-]{0,${NAME_MAX}}(?:pass|secret|token|key)[\\w.-]{0,${NAME_MAX}}=`, '', 'a secret given with --from-literal', { flags: 'i' }],
  [`\\baz\\s[^\\n|;&]{0,${GAP}}?\\s-p(?:=|\\s+)`, '(?!-)', 'an Azure CLI password'],
  ['\\bhtpasswd\\s+(?:-[a-zA-Z]+\\s+){0,2}-[a-zA-Z]*b[a-zA-Z]*\\s+(?:-[a-zA-Z]+\\s+){0,2}[^\\s"\']+\\s+[^\\s"\']+\\s+', '', 'an htpasswd password'],
  [`\\baws\\s+configure\\s+set\\s+(?:--profile\\s+\\S+\\s+)?[\\w.-]{0,${NAME_MAX}}secret[\\w.-]{0,${NAME_MAX}}\\s+`, '', 'an AWS secret key set with aws configure', { flags: 'i' }],
  // any variable whose name has KEY, TOKEN, SECRET, PASS, PASSWD, PWD or PASSWORD as a part (`DB_PASS`, `TOKEN_FILE_X`, `ADMINPASSWORD`), as two rules so that only the
  // KEY/TOKEN names get NOT_A_TOKEN_VALUE; a name with both kinds (`API_KEY_PASSWORD`) is a password name.
  // CODE_VALUE (a `{{` is a template, judged by TEMPLATE_VALUE): `key==x`, `key=>x`, `const key=s=>...`, `token=[]`, `key=(a)`, `token=fs.readFileSync(p)`, `key=lambda s:` are program code (heredocs, node -e), not literals
  [`${BOUNDARY}[\\w.-]{0,${NAME_MAX}}(?:${PASSWORD_NAME_PART})[\\w.-]{0,${NAME_MAX}}=`, CODE_VALUE, 'a key, token, secret or password assigned in the command', { flags: 'i' }],
  [`${BOUNDARY}(?![\\w.-]{0,${NAME_MAX}}(?:${PASSWORD_NAME_PART}))[\\w.-]{0,${NAME_MAX}}(?:${TOKEN_NAME_PART})[\\w.-]{0,${NAME_MAX}}=`, `${CODE_VALUE}(?!${NOT_A_TOKEN_VALUE})`, 'a key, token, secret or password assigned in the command', { flags: 'i' }],
  [`[?&](?:${QUERY_TOKEN_KEYS})=`, QUERY_TOKEN_NOT_LITERAL, 'a token or key in a URL query string', { start: QUERY_START }],
  [`[?&](?:${QUERY_SECRET_KEYS})=`, QUERY_NOT_LITERAL, 'a password or secret in a URL query string', { start: QUERY_START }],
  [`\\bredis-cli\\b[^\\n|;&]{0,${GAP}}?\\s(?:-a|--pass)\\s+`, '', 'a redis password'],
  ['(?<![A-Za-z0-9])_(?:authToken|auth|password)=|(?<![A-Za-z0-9])_authToken\\s+', '', 'an npm registry credential', { flags: 'i' }],
  // `bearer` spelled in lowercase and followed by a short lowercase word is prose ("a bearer token is ...", seen in docs written through heredocs), not a
  // token: a real one has digits, capitals or length. `Bearer x` and an `Authorization:` header keep their rules.
  [`\\b${caseless('bearer')}\\s+`, `(?!(?<=\\bbearer\\s+)${BEARER_PROSE_WORD})`, 'a bearer token'],
  [`${HTTP_TOOL}\\s(?:-u|--user)(?:=|\\s*)[^\\s:"']*:`, '', 'a user:password pair', { value: '["\']?[^\\s"\';&|]+["\']?' }],
  [`${HTTP_TOOL}\\s(?:-u|--user)(?:=|\\s*)["'][^"':]*:`, '', 'a user:password pair', { value: '[^"\']+' }],
  [`\\b${HEADER_NAME}\\s*:[ \\t]*`, FORMAT_PLACEHOLDER, 'a credential header with a literal value', { value: HEADER_VALUE }],
  [`(?<!\\b(?:docker|podman|buildx|buildah)\\b[^\\n|;&]{0,${GAP}})--secret(?:=|\\s+)`, '(?!-)', 'a secret flag with a literal value'],
  ['\\b[a-z][a-z0-9+.-]{0,30}://[^\\s/@:"\']{1,200}:', URL_NOT_A_PORT, 'a password inside a URL', { value: URL_PASSWORD, flags: 'i' }],
].map(([prefix, lookahead, kind, { value, flags = '', start = NOT_LITERAL_START, inData = false } = {}]) => ({
  kind,
  inData,
  detect: new RegExp(`${prefix}${start}${lookahead}${value ?? VALUE}`, flags),
  mask: new RegExp(`(${prefix})${start}${lookahead}(?:${value ?? VALUE_RUN})`, `g${flags}`),
}));
const MASK = '[masked]';
// A field name that holds a credential in a tool's JSON input: the same KEY/TOKEN and SECRET/PASS/PASSWORD parts as the variable rules above,
// plus header-style names. camelCase humps count as a boundary (`apiKey`, `clientSecret`); `keyboard`, `passport` and `max_tokens` do not match.
const SECRET_FIELD_NAME = new RegExp(`${PASSWORD_NAME_PART}|${TOKEN_NAME_PART}|AUTHORIZATION|COOKIE|CREDENTIAL|(?<![A-Za-z0-9])AUTH(?![A-Za-z0-9])`, 'i');
const CAMEL_HUMP = /([a-z0-9])([A-Z])/g;

// Placeholders (F16): a value made WHOLLY of stand-in text is no secret (`.env.example` written through a heredoc). Only a whole value
// counts, so a real key with "example" or "xxxx" added to it still asks.
const PLACEHOLDER_VALUE = new RegExp(String.raw`^(?:(.)\1{2,}|\.{3,}|…|<[A-Za-z][\w .-]{0,40}>|`
  + String.raw`your[-_]?[a-z_-]{0,30}(?:key|token|secret|password|pass|here|id)|changeme|placeholder|redacted|dummy|example)$`, 'i');
const TOKEN_PREFIX = /^(?:sk-ant-(?:[a-z]+\d+-)?|sk-proj-|gh[pousr]_|github_pat_|glpat-|xox[bp]-|AKIA|ASIA)/;
const AWS_DOCS_EXAMPLE_ID = 'IOSFODNN7EXAMPLE'; // the access key id AWS's own documentation uses, after its AKIA prefix
const TOKEN_SCANS = TOKEN_KINDS.map(([pattern]) => ({ scan: new RegExp(pattern.source, `g${pattern.flags}`) }));
const unquoted = (value) => value.replace(/^(["'])([\s\S]*)\1$/, '$2');
const blank = (text) => ' '.repeat(text.length); // keeps every other position, so the rules read the rest unchanged

/** A token whose part after its kind's prefix is one character repeated (an all-`x` key), or AWS's documentation example. */
function isPlaceholderToken(token) {
  const rest = token.replace(TOKEN_PREFIX, '').replace(/[-_]/g, '');
  return /^(.)\1*$/.test(rest) || rest === AWS_DOCS_EXAMPLE_ID;
}

/** The value of a value rule's mask match (group 1 is the prefix), without its quotes. */
const valueOfMatch = (whole, prefix) => unquoted(whole.slice(prefix.length).trim());

/**
 * The text with every placeholder value inside a heredoc body blanked out. The rules then run on it unchanged: a placeholder can only take its own text away,
 * never hide a real value next to it (a value the mask patterns cannot list stays in the text, and still asks).
 * @param {string} command the text to scan
 * @returns {string} the same text, each placeholder value replaced by spaces of the same length
 */
function withoutPlaceholders(command) {
  return command.replace(HEREDOC_BODY, (whole, open, _quote, _word, body, close) => open + blankedPlaceholders(body) + close);
}

// a heredoc: the `<<WORD` line, its body, the line with WORD alone; only bodies are files of placeholders (outside them the strict rule stays)
const HEREDOC_BODY = /(<<-?[ \t]*(['"]?)(\w+)\2[^\n]*\n)([\s\S]*?)(\n[ \t]*\3[ \t]*(?:\n|$))/g;

/** One heredoc body with its placeholder values blanked out. */
function blankedPlaceholders(body) {
  let text = body;
  for (const { scan } of TOKEN_SCANS) text = text.replace(scan, (token) => (isPlaceholderToken(token) ? blank(token) : token));
  for (const { mask } of VALUE_KINDS) {
    const blankPlaceholder = (whole, prefix) => (PLACEHOLDER_VALUE.test(valueOfMatch(whole, prefix)) ? prefix + blank(whole.slice(prefix.length)) : whole);
    text = text.replace(mask, blankPlaceholder);
  }
  return text;
}

/**
 * @param {string} command raw command text
 * @returns {string | undefined} what kind of secret was found, or undefined; never the value
 */
export function findLiteralSecret(command) {
  command = withoutPlaceholders(command.slice(0, MAX_SCAN_CHARS));
  for (const [pattern, kind] of TOKEN_KINDS) {
    if (pattern.test(command)) return kind; // a known token shape is a secret in data text too: written into a file, it still asks
  }
  const shellText = dataTextRemoved(command);
  return VALUE_KINDS.find(({ detect, inData }) => detect.test(inData ? command : shellText))?.kind;
}

/**
 * Hides every literal secret findLiteralSecret detects, so the text can go to a dialog or a log.
 * @param {string} command raw command text
 * @returns {string} the command with each secret value replaced by "[masked]"
 */
export function maskSecrets(command) {
  let text = command.slice(0, MAX_SCAN_CHARS);
  for (const [pattern] of TOKEN_KINDS) text = text.replace(new RegExp(pattern.source, 'g'), MASK);
  for (const { mask } of VALUE_KINDS) text = text.replace(mask, `$1${MASK}`);
  return command.length > MAX_SCAN_CHARS ? `${text}[...cut]` : text;
}

/**
 * A tool input (any JSON value, e.g. an MCP call) as JSON with every credential hidden, so it can go to a dialog or a log: a string or number
 * under a secret-looking field name (`password`, `apiKey`, `X-Api-Key`, `Authorization`, at any depth) becomes "[masked]", then maskSecrets
 * hides the secret shapes left in other fields.
 * @param {unknown} value parsed tool input
 * @returns {string} masked JSON text
 * @throws {TypeError} when the value cannot be written as JSON (a cycle or a BigInt), as JSON.stringify does
 */
export function maskSecretFields(value) {
  const isSecretName = (name) => SECRET_FIELD_NAME.test(name.replace(CAMEL_HUMP, '$1_$2'));
  const json = JSON.stringify(value, (name, field) => ((typeof field === 'string' || typeof field === 'number') && isSecretName(name) ? MASK : field));
  return json === undefined ? '' : maskSecrets(json);
}

const WORD_REST = /^[^\s;&|]*/;
const QUOTES = /["']/g;

/** The value plus whatever continues the same shell word (`'known'TAIL` is one word), quotes removed. */
const wholeWord = (text, valueText, end) => `${valueText}${text.slice(end).match(WORD_REST)[0]}`.replace(QUOTES, '');

/**
 * Every literal secret value the rules above find (same patterns and scan limit as findLiteralSecret/maskSecrets). A value
 * is the whole shell word it sits in, quotes removed, so a value with text glued on (`'known'TAIL`) is the combined word.
 * The values are raw: the caller must hash them and never print or store them.
 * @param {string} command raw command text
 * @returns {string[]} distinct non-empty values, in the order the rules found them
 */
export function literalSecretValues(command) {
  const text = command.slice(0, MAX_SCAN_CHARS);
  const found = [];
  for (const [pattern] of TOKEN_KINDS) {
    for (const match of text.matchAll(new RegExp(pattern.source, 'g'))) found.push(wholeWord(text, match[0], match.index + match[0].length));
  }
  for (const { mask } of VALUE_KINDS) {
    for (const match of text.matchAll(mask)) found.push(wholeWord(text, match[0].slice(match[1].length), match.index + match[0].length));
  }
  return [...new Set(found.filter((value) => value !== ''))];
}

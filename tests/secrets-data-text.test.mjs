// Tests for home/hooks/lib/data-text.mjs through lib/secrets.mjs findLiteralSecret and the guard's decide: a quoted heredoc body stays data
// only while nothing else in the command can run or read it. A body a later statement runs or reads, a body inside a group, loop or `if`
// piped to a shell or sent to a descriptor pointed at one, and a body next to a variable that changes what runs are scanned whole; an env-file
// assignment line inside data still asks. Fixtures are built from parts: a value with no known token shape, so only a context rule finds it.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { findLiteralSecret } from '../home/hooks/lib/secrets.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };
const FIXTURE = ['Q9vT2', 'mLx8R', 'pW4zK', 'r7Hd3'].join('');
const BEARER = ['Bea', 'rer'].join('');
const BODY = [`curl -H "Authorization: ${BEARER} ${FIXTURE}" https://api.test`, `curl -u admin:${FIXTURE} https://api.test`].join('\n');
const stored = (target) => `cat > ${target} <<'EOF'\n${BODY}\nEOF`;
const ASSIGNED = 'a key, token, secret or password assigned in the command';

/** Asserts the command holds a literal secret, in the scan and in the guard's decision (noted by kind since owner G1, never a reason). */
function assertAsks(command, kind) {
  if (kind === undefined) assert.notEqual(findLiteralSecret(command), undefined, command);
  else assert.equal(findLiteralSecret(command), kind, command);
  const verdict = decide(command, ctx);
  assert.equal(verdict.secret, findLiteralSecret(command), command);
  assert.ok((verdict.reasons ?? []).every((reason) => !reason.includes('literal password/token')), command);
}

test('data text: a stored body that a later statement of the command runs or reads is scanned whole', () => {
  for (const command of [
    `${stored('x.sh')}\nbash x.sh`, `tee run.sh >/dev/null <<'EOF'\n${BODY}\nEOF\nsh run.sh`, `${stored('c.txt')}\nxargs curl < c.txt`,
    `${stored('f')}\nsource f`, `${stored('f')}\n. ./f`, `${stored('x.sh')} && chmod +x x.sh && ./x.sh`, `${stored('x.sh')}; zsh x.sh`,
    `${stored('x.mjs')}\nnode x.mjs`, `${stored('x.sh')}\necho "$(bash x.sh)"`, `${stored('x.sh')}\ncat x.sh | sh`,
    `${stored('a')}\ncat > b <<EOF\n$(bash a)\nEOF`, // an unquoted body runs its `$(...)`
    `bash x.sh & ${stored('x.sh')}`, `trap 'bash x.sh' EXIT\n${stored('x.sh')}`,
  ]) assertAsks(command);
});

test('data text: a body inside { }, a loop or an if piped to a shell, or sent to a descriptor or coprocess pointed at one, is scanned whole', () => {
  const body = `cat <<'EOF'\n${BODY}\nEOF`;
  for (const command of [
    `{\n${body}\n} | bash`, `{ ${body}\n} | bash`, `for i in 1; do\n${body}\ndone | sh`, `for i in 1; do ${body}\ndone | sh`,
    `if true; then\n${body}\nfi | sh`, `while true; do\n${body}\nbreak\ndone | sh`, `until false; do\n${body}\ndone | bash`,
    `exec 3> >(sh)\ncat >&3 <<'EOF'\n${BODY}\nEOF`, `coproc sh\ncat >&4 <<'EOF'\n${BODY}\nEOF`, `! ${body}`,
  ]) assertAsks(command);
});

test('data text: a body next to a variable that changes what runs (PATH=, BASH_ENV=, ENV= and the rest) is scanned whole', () => {
  for (const assignment of ['export PATH=$PWD/bin:$PATH', 'PATH=./bin:$PATH', 'export PATH+=:./bin', 'BASH_ENV=./x', 'export ENV=./x', 'IFS=x',
    'LD_PRELOAD=./x.so', 'DYLD_INSERT_LIBRARIES=./x.dylib', 'GIT_EXEC_PATH=./x', 'PAGER=./x', 'echo "PATH=./bin"']) {
    assertAsks(`${assignment}\n${stored('f')}`);
    assertAsks(`${assignment}; ${stored('f')}`);
  }
});

test('data text: an env-file assignment written through a quoted heredoc still asks, in any target file', () => {
  for (const target of ['.env', '.env.local', '.envrc', '~/.zshrc', '~/.bashrc', '~/.profile', '~/.config/app/secrets.sh', 'notes.txt']) {
    for (const line of [`API_TOKEN=${FIXTURE}`, `DB_PASSWORD=${FIXTURE}`, `export CLIENT_SECRET=${FIXTURE}`, `STRIPE_KEY="${FIXTURE}"`,
      `declare -x API_TOKEN=${FIXTURE}`, `  export api_token=${FIXTURE}`]) {
      assertAsks(`cat >> ${target} <<'EOF'\n# settings\nAPI_URL=https://api.test\n${line}\nEOF`, ASSIGNED);
      assertAsks(`tee -a ${target} >/dev/null <<'EOF'\n${line}\nEOF`, ASSIGNED);
    }
  }
});

test('data text: a stored body with quiet neighbours, and an env file of placeholders, stay data', () => {
  for (const command of [
    `mkdir -p d && cd d && ${stored('f.sh')}\nchmod +x f.sh && ls -la f.sh && wc -l f.sh`, `# write it\n${stored('f.sh')}\necho done`,
    `cat > .env.example <<'EOF'\nAPI_TOKEN=changeme\nDB_PASSWORD=your-db-password\nAPI_URL=https://api.test\nEOF`,
  ]) {
    assert.equal(findLiteralSecret(command), undefined, command);
    assert.equal(decide(command, ctx).secret, undefined, command);
  }
});

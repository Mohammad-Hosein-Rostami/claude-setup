// Tests for home/hooks/pre-bash-guard.mjs: decide() and segments() tables plus the stdin/exit-code contract
// (node:test, no dependencies). Project and cwd are a fake path outside any temp dir so "outside" is unambiguous.
import './pin-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hookEnv } from './hook-env.mjs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, segments } from '../home/hooks/pre-bash-guard.mjs';

const HOOK = fileURLToPath(new URL('../home/hooks/pre-bash-guard.mjs', import.meta.url));
const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT };

const DENIED = {
  'C3 separators and groups': [
    'true & rm -rf ~/x', '(rm -rf ~/x)', 'echo $(rm -rf ~/x)', 'echo `rm -rf ~/x`', 'echo "$(rm -rf ~/x)"',
    '{ rm -rf ~/x; }', 'if true; then rm -rf ~/x; fi', 'for d in a; do rm -rf /etc/y; done', '! rm -rf ~/x',
    'time rm -rf ~/x', 'true & git push --force',
    '(git commit --no-verify -m x)', 'if true; then git commit -n; fi', 'while true; do git push -f; done',
    'bash -c "rm -rf ~/x"', 'bash -lc "git push --force"',
  ],
  'C4 cd tracking': [
    'cd ~ && rm -rf Documents', 'cd .. && rm -rf sibling', 'cd / && rm -rf etc', 'pushd /etc; rm -rf foo',
    '(cd ~ && rm -rf Documents)', 'cd $X && rm -rf a', 'cd && rm -rf a', 'cd - && rm -rf a', 'cd a; popd; rm -rf b',
  ],
  'C5 command name and wrappers': [
    '/bin/rm -rf ~/x', '\\rm -rf ~/x', 'sudo -u me rm -rf ~/x', 'timeout 5 rm -rf ~/x', 'timeout -s KILL 5 rm -rf ~/x',
    'env -i rm -rf ~/x', 'xargs rm -rf <<< ~/x', 'nice -n 5 rm -rf ~/x', 'command rm -rf ~/x', 'exec rm -rf ~/x',
    'nohup rm -rf ~/x', 'FOO=1 /bin/rm -rf ~/x', '/usr/bin/git push -f', 'sudo -- rm -rf ~/x', 'stdbuf -o0 rm -rf ~/x',
  ],
  'C13 force push clusters': [
    'git push -fu origin main', 'git push -uf origin main', 'git -C d push -vf', 'git push --force', 'git push origin main -f',
    'git push origin +main',
  ],
  'P1 unknown cd targets keep the outside rule': [
    'cd $X && rm -rf y', 'cd $(pwd)/.. && rm -rf y', 'cd ~other && rm -rf y', 'cd ~/proj && rm -rf ../other', 'cd "$HOME" && rm -rf Documents',
    'cd ~ && rm -rf proj', 'cd $HOME/other && rm -rf y', 'cd ${HOME} && rm -rf Documents', 'cd $(git rev-parse --show-toplevel)/.. && rm -rf y',
    'cd $(git rev-parse --show-toplevel)/../other && rm -rf y',
  ],
  'F1 git top-level only maps from inside the project': [
    'cd ../other && cd "$(git rev-parse --show-toplevel)" && rm -rf src', 'cd /etc && cd $(git rev-parse --show-toplevel) && rm -rf src',
    'cd ../other && cd `git rev-parse --show-toplevel` && rm -rf src', 'cd .. && cd "$(git rev-parse --show-toplevel)/sub" && rm -rf src',
  ],
  'F1 quoted redirect characters are plain arguments': [
    'rm -rf ">" /', 'rm -rf "2>" ~', 'rm -rf "2>>" /etc',
  ],
  'F1 rm targets with ~ and $HOME': ['rm -rf ~', 'rm -rf ~/Desktop', 'rm -rf $HOME/Desktop', 'rm -rf ${HOME}', 'rm -rf ~/work/proj/dist'],
  'S3 broad project roots': [],
  'S4 git bypasses': [
    'git commit --no-veri', 'git commit --no-verif', 'git commit --no-verif"y"', 'git push --no-verif', 'git -c core.hooksPath=/dev/null commit',
    'git -ccore.hooksPath=x commit', 'git -c core.hookspath=x push', 'HUSKY=0 git commit -m x', 'env HUSKY=0 git push',
    'git push --mirror', 'git push origin +main', 'git push --delete origin x', 'git push -d origin x', 'git push origin :main',
    'git push origin :refs/tags/v1',
  ],
  'lockfile edits': [
    'sed -i s/a/b/ pnpm-lock.yaml', 'echo x > yarn.lock', 'cp a package-lock.json', 'mv x pnpm-lock.yaml', 'echo x &> bun.lockb',
  ],
};

const ALLOWED = [
  'git commit -m "feat: x"', 'git commit -am fix', 'rm -r ./dist', 'rm -rf node_modules', 'rm -rf dist 2>&1',
  'rm -rf dist > /dev/null', 'rm -rf dist 2> /dev/null', 'rm pnpm-lock.yaml', 'rm -f ~/x', 'pnpm test && pnpm lint',
  'cat .env.example', 'cat .env.sample', 'cat .env.template', 'cp .env.example .env', 'cat .eslintrc', 'cat .editorconfig',
  'cat .eslintrc*', 'cd sub && rm -rf dist', 'cd packages/app && rm -rf dist', 'cd ./a && cd .. && rm -rf dist',
  'echo hi &', 'cmd 2>&1 | tee out.log', 'npm test &> out.log', 'for f in a b; do echo $f; done', 'echo $(pwd)',
  'cp package-lock.json backup.json', 'pnpm install', 'sudo apt install x', 'timeout 5 pnpm test', '# rm -rf ~/x',
  'xargs -I {} rm -rf {}', 'cat *', 'cat src/*', 'cat *.*', 'cat logs/*', 'ls *.env', 'rg "\\.env" src', 'grep -rn ".env" src',
  'grep -rn .env src', 'grep -A 3 .env src', 'rg -g .env FOO src', 'sed s/.env/x/ f.txt', "awk '/.env/' f.txt", 'jq .env package.json',
  "jq -r '.env' package.json", 'cp .env.example .env', 'cp .env.sample x', 'cp a b .env.d/', 'cp -t dir a b', 'scp a host:.env',
  'rsync -a src host:.env', 'rsync --exclude .env src dest', 'rsync --exclude=.env src dest', 'tar --exclude .env -czf o.tgz .',
  'zip -r o.zip . -x .env', 'git show HEAD:README.md', 'git show HEAD:.env.example', 'git diff HEAD~1 -- src', 'curl https://x.test/.env',
  'curl -H "X: .env" https://x.test', "curl -d 'a=b@c.com' https://x.test", 'node --env-file=.env app.js', 'node --env-file .env app.js',
  'node -e "1" .env', 'python -m dotenv -f .env run -- x', 'python script.py .env', 'docker compose --env-file .env up',
  'dotenv -e .env -- pnpm dev', 'ls -la .env', 'rm .env', 'touch .env', 'cat .env.example < /dev/null', 'sort a.txt', 'dd if=in of=out',
  'cat .ENV.EXAMPLE', 'git -c user.name=x commit -m y', 'git commit -m "feat: use --no-verify"', 'HUSKY=0 pnpm install',
  'cat > .env <<EOF\nFOO=1\nEOF', 'sort a.txt > .env.sorted', 'echo FOO=1 >> .env', 'echo FOO=1 >.env', 'echo x 2> .env.log', 'cat a &> .env',
  'cat a >| .env', 'cat a.txt >.env.out', 'cat a 2>&1 > .env', 'sort a.txt >> .env.local', 'cat .env.example > .env',
  'echo ">" out', 'echo "a > b"', 'git commit -m "> note"', 'grep -rn "<div>" src', 'echo ok>out.txt', 'cat a.txt>.env', 'rm -rf dist>/dev/null',
  'cat a>.env.out', 'cat < a.txt', 'echo "2>&1"', 'git push --dry-run', 'git diff --stat', 'bash -c "pnpm test"', 'cat <<EOF\nrm -rf ~/x\nEOF',
];

for (const [group, commands] of Object.entries(DENIED)) {
  test(`decide denies: ${group}`, () => {
    for (const command of commands) assert.equal(decide(command, ctx).allow, false, command);
  });
}

test('decide allows normal dev commands', () => {
  for (const command of ALLOWED) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('S3: $HOME, / and a drive root never count as the project', () => {
  const home = homedir();
  for (const project of [home, '/', '/c/']) {
    for (const command of ['rm -rf dist', 'rm -r ./a', `rm -rf ${project === '/' ? '/usr' : project}/x`]) {
      assert.equal(decide(command, { cwd: project, project }).allow, false, `${project}: ${command}`);
    }
  }
  assert.equal(decide('rm -rf dist', { cwd: `${home}/work/p`, project: home }).allow, false);
  assert.equal(decide('rm -rf dist', { cwd: `${home}/work/p`, project: `${home}/work/p` }).allow, true);
  assert.equal(decide('rm -rf /tmp/x', { cwd: home, project: home }).allow, true);
});

test('P1: cd to ~, $HOME and the git top-level resolves when that directory is the project', () => {
  const proj = `${homedir()}/proj`;
  const at = { cwd: proj, project: proj };
  for (const command of [
    'cd ~/proj && rm -rf node_modules', 'cd $HOME/proj && rm -rf node_modules', 'cd ${HOME}/proj && rm -rf node_modules',
    'cd "$HOME/proj/sub" && rm -rf dist', 'cd "$(git rev-parse --show-toplevel)" && rm -rf dist',
    'cd $(git rev-parse --show-toplevel) && rm -rf dist', 'cd `git rev-parse --show-toplevel` && rm -rf dist',
    'cd "$(git rev-parse --show-toplevel)/packages/a" && rm -rf dist', 'cd ~/proj/sub; cd .. && rm -rf dist',
  ]) {
    assert.deepEqual(decide(command, at), { allow: true }, command);
  }
  for (const command of ['cd ~ && rm -rf proj', 'cd ~/other && rm -rf y', 'cd $HOME && rm -rf Documents', 'cd ~/proj/.. && rm -rf y']) {
    assert.equal(decide(command, at).allow, false, command);
  }
  assert.equal(decide('cd ~ && rm -rf dist', { cwd: homedir(), project: homedir() }).allow, false, 'a home project is broad');
  assert.equal(decide('cd "$(git rev-parse --show-toplevel)" && rm -rf dist', { cwd: homedir(), project: homedir() }).allow, false);
});

test('F1: rm -r targets expand a leading ~ or $HOME; the git top-level maps only from inside the project', () => {
  const proj = `${homedir()}/proj`;
  const at = { cwd: proj, project: proj };
  for (const command of ['rm -rf ~/proj/dist', 'rm -rf $HOME/proj/dist', 'rm -rf ${HOME}/proj/a/b', 'cd sub && cd "$(git rev-parse --show-toplevel)" && rm -rf dist']) {
    assert.deepEqual(decide(command, at), { allow: true }, command);
  }
  for (const command of ['rm -rf ~', 'rm -rf ~/Desktop', 'rm -rf ~/proj/..', 'rm -rf ~/proj', 'cd ~ && cd "$(git rev-parse --show-toplevel)" && rm -rf dist']) {
    assert.equal(decide(command, at).allow, false, command);
  }
  assert.equal(decide('rm -rf ~/proj/dist', { cwd: null, project: proj }).allow, true, 'absolute after expansion');
});

test('F1: segments mark quoted redirect lookalikes and split attached operators', () => {
  assert.deepEqual(segments('echo ">" a'), [['echo', '\u0001>', 'a']]);
  assert.deepEqual(segments('cat .env>out'), [['cat', '.env', '>out']]);
  assert.deepEqual(segments('cat<.env'), [['cat', '<.env']]);
  assert.deepEqual(segments('cat 2>err.log a>>b'), [['cat', '2>err.log', 'a', '>>b']]);
  assert.deepEqual(segments('echo "x">"y"'), [['echo', 'x', '>y']]);
  assert.match(decide('rm -rf ">" /', ctx).reason, /^DESTRUCTIVE: rm -r outside the project \(\/\)$/);
});

test('P1: segments keep >| together and the git top-level becomes one word', () => {
  assert.deepEqual(segments('cat a >| out'), [['cat', 'a', '>|', 'out']]);
  assert.deepEqual(segments('cd $(git rev-parse --show-toplevel) && ls'), [['cd', '$__GIT_TOPLEVEL__'], ['ls']]);
});

test('S4: git bypasses ask with a plain reason, history rewrites ask with a DESTRUCTIVE one', () => {
  for (const [command, reason] of [['HUSKY=0 git commit', /^HUSKY=0 skips/], ['git -c core.hooksPath=x commit', /^git -c core\.hooksPath/], ['git push --mirror', /^DESTRUCTIVE: git push --mirror/], ['git push -d origin x', /^DESTRUCTIVE: deleting a remote/], ['git push -f', /^DESTRUCTIVE: force push/]]) {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, command);
    assert.match(r.reason, reason, command);
  }
  assert.match(decide('git commit --no-veri', ctx).reason, /--no-verify/);
});

test('S6: heredoc stripping is linear: a 250 KB command with many <<A decides in under a second', () => {
  const unterminated = 'cat <<A\n'.repeat(31_250);
  const terminated = 'cat <<A\nrm -rf ~/x\nA\n'.repeat(11_000);
  const terminatedUnderCap = 'cat <<A\nrm -rf ~/x\nA\n'.repeat(1_200);
  const sameLine = `cat ${'<<A '.repeat(62_500)}`;
  for (const command of [unterminated, terminated, sameLine]) {
    const started = performance.now();
    decide(command, ctx);
    assert.ok(performance.now() - started < 1000, `${command.length} bytes took too long`);
  }
  assert.ok(decide(terminatedUnderCap, ctx).allow, 'terminated heredoc bodies are data');
  assert.match(decide(terminated, ctx).reason, /too long/, 'over the cap asks instead of parsing');
});

test('S6: heredoc bodies are skipped, several operators per line are paired in order', () => {
  assert.deepEqual(segments('cat <<A <<B\nrm -rf ~/x\nA\nsecond\nB\necho ok'), [['cat', '<<A', '<<B'], ['echo', 'ok']]);
  assert.deepEqual(segments('cat <<-EOF\n\trm -rf ~/x\n\tEOF\nls'), [['cat', '<<-EOF'], ['ls']]);
  assert.equal(decide('cat <<A\nrm -rf ~/x', ctx).allow, false, 'unterminated heredoc stays visible');
});

test('decide: deny reasons name the problem', () => {
  assert.match(decide('git push -fu origin main', ctx).reason, /force push/);
  assert.match(decide('git commit -n', ctx).reason, /--no-verify/);
  assert.match(decide('rm -rf ~/x', ctx).reason, /outside the project/);
  assert.match(decide('echo x > pnpm-lock.yaml', ctx).reason, /generated/);
});

test('decide: unknown cwd only denies relative rm -r targets', () => {
  const unknown = { cwd: null, project: PROJECT };
  assert.equal(decide('rm -rf dist', unknown).allow, false);
  assert.equal(decide(`rm -rf ${PROJECT}/dist`, unknown).allow, true);
});

test('segments splits on & && || ; | and newline', () => {
  assert.deepEqual(segments('a && b | c; d & e\nf || g'), [['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']]);
});

test('segments joins adjacent quoted parts and strips quotes', () => {
  assert.deepEqual(segments('cat .e"nv"'), [['cat', '.env']]);
  assert.deepEqual(segments(`git commit -m 'a b;c' "d && e"`), [['git', 'commit', '-m', 'a b;c', 'd && e']]);
});

test('segments splits groups, substitutions and backticks into their own commands', () => {
  assert.deepEqual(segments('echo $(rm x)'), [['echo', '$'], ['rm', 'x']]);
  assert.deepEqual(segments('(a; b)'), [['a'], ['b']]);
  assert.deepEqual(segments('x `y z`'), [['x'], ['y', 'z']]);
});

test('segments keeps redirections together and drops heredoc bodies', () => {
  assert.deepEqual(segments('cmd 2>&1 &> out'), [['cmd', '2>&1', '&>', 'out']]);
  assert.deepEqual(segments('cat <<EOF\nrm -rf ~/x\nEOF'), [['cat', '<<EOF']]);
});

const runHook = (input, env = {}) =>
  spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: hookEnv({ CLAUDE_PROJECT_DIR: PROJECT, ...env }) });

test('hook contract: bad JSON, empty stdin and missing command exit 0 silently', () => {
  for (const input of ['not json', '', '{}', JSON.stringify({ tool_input: {} }), JSON.stringify({ tool_input: { command: 5 } })]) {
    const r = runHook(input);
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout + r.stderr, '', input);
  }
});

test('hook contract: an allowed command is silent; a rule hit asks (no GUI: the native ask) and never exits 2', () => {
  const run = (command) => runHook(JSON.stringify({ cwd: PROJECT, tool_input: { command } }));
  const ok = run('pnpm test && pnpm lint');
  assert.equal(ok.status, 0);
  assert.equal(ok.stderr, '');
  const hit = run('git push -fu origin main');
  assert.equal(hit.status, 0);
  assert.equal(hit.stderr, '');
  const out = JSON.parse(hit.stdout).hookSpecificOutput;
  assert.equal(out.permissionDecision, 'ask');
  assert.match(out.permissionDecisionReason, /^DESTRUCTIVE: force push/);
});

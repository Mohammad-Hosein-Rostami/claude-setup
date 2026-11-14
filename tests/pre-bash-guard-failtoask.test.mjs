// Round 4 of the guard audit: the fail-to-ask rule. A command with a hidden-execution construct ($(, backtick, <<, <(, eval, trap, case,
// carriage return, a pipe into a shell ...) that names a dangerous word anywhere in its raw text asks, whatever either parser made of the quoting.
// Every silent bypass of the re-audit is a case in ASKS; HARMLESS must stay silent (a false positive costs an unattended run up to 3 minutes).
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { isReadOnlySql } from '../home/hooks/lib/sql.mjs';
import { lexShell } from '../home/hooks/lib/shell-lexer.mjs';
import { riskyWordInExpansion } from '../home/hooks/lib/raw-risk.mjs';
import { logDecision } from '../home/hooks/lib/guard-log.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: ['db.prod.example.com'] };
const DESTRUCTIVE = /^DESTRUCTIVE: /;

const ASKS = [
  "x=\"$(( $(git push --force origin main) ))\"",
  "echo $(( $(git push --force origin main) ))",
  "x=\"$(( `git push --force origin main` ))\"",
  "out=\"$(case x in x) git push --force origin main;; esac)\"",
  "out=$(case x in x) git push --force origin main;; esac)",
  "x=`echo \\`git push --force origin main\\``",
  "`echo \\`git push --force origin main\\``",
  "cat <<\"E\"OF\nbody\nEOF\ngit push --force origin main\nE",
  "cat <<E\"OF\"\nbody\nEOF\ngit push --force origin main\nE",
  "cat <<E\\OF\nbody\nEOF\ngit push --force origin main\nE",
  "cat <<'E'OF\nbody\nEOF\ngit push --force origin main\nE",
  "echo x\r# \"$(git push --force origin main)\"",
  "echo\r# \"$(git push --force origin main)\"",
  "echo x\r# `git push --force origin main`",
  "trap 'git push --force origin main' EXIT",
  "trap \"git push --force origin main\" EXIT",
  "source /dev/stdin <<< 'git push --force origin main'",
  ". /dev/stdin <<<\"git push --force origin main\"",
  "echo 'git push --force origin main' | source /dev/stdin",
  "source <(echo 'git push --force origin main')",
  "bash <(echo 'git push --force origin main')",
  "bash <<< 'git push --force origin main'",
  "cat <<-EOF\n\tbody\n\tEOF\ngit push --force origin main",
  "cat <<EOF\n$(git push --force origin main)\nEOF",
  "cat <<EOF\n`git push --force origin main`\nEOF",
  "cat > f <<EOF\nhello ${x:-$(git push --force origin main)}\nEOF",
  "x=${y:-$(git push --force origin main)}",
  "x=\"${y:-$(git push --force origin main)}\"",
  "x=\"${y:-\"$(git push --force origin main)\"}\"",
  "cat <(git push --force origin main)",
  "tee >(git push --force origin main) < /dev/null",
  "diff <(git log) >(git push --force origin main)",
  "coproc git push --force origin main",
  "coproc P { git push --force origin main; }",
  "function f { git push --force origin main; }; f",
  "f() { git push --force origin main; }; f",
  "(( x = $(git push --force origin main) ))",
  "x=\"$(echo $'\\'' ; git push --force origin main)\"",
  "x=\"$(echo hi # )\ngit push --force origin main\n)\"",
  "x=\"$(echo \"a\\\"b\" ; git push --force origin main)\"",
  "x=\"a\\\"$(git push --force origin main)\\\"\"",
  "find . -maxdepth 0 -exec git push --force origin main ;",
  "xargs -a /dev/null git push --force origin main",
  "nohup bash -c 'git push --force origin main' &",
  "git push --force origin main",
  "git\tpush -f",
  "python3 -c \"import os; os.system('git -${F:--namespace} stash push -f origin main')\"",
  "python3 - <<'E'\nprint(1)\nE\ngit -C dir stash push -f origin main",
  "node -e \"require('child_process').execSync('git -c url.https://github.com/o/r.insteadOf=stash -C \\'\\' push -f stash main')\"",
  "python3 - <<'E'\nprint(1)\nE\ngit -C '' push -f origin main",
  "python3 - <<'E'\nprint(1)\nE\ngit stash list /usr/bin/git push -f",
  "python3 - <<'E'\nprint(1)\nE\ngit stash push && git push -f",
  "python3 - <<'E'\nprint(1)\nE\ngit stash push -m x push",
  "python3 - <<'E'\nprint(1)\nE\ngit -c alias.stash=push stash push",
  "eval \"$(echo git push --force origin main)\"",
  "BASH_ENV=<(echo 'git push --force origin main') bash x.sh",
  "time git push --force origin main",
  "exec git push --force origin main",
  "\\git push -f",
  "g\\\nit push -f",
  "git push -\\\nf",
  "\"git\" \"push\" \"-f\"",
  "x=\"$(cat <<'EOF'\nhello )\nEOF\ngit push --force origin main)\"",
  "x=\"$(cat <<'EOF'\nhello\nEOF\n)\"; git push --force origin main",
  "echo \"$(echo ')')\" ; git push --force origin main",
  "echo \"`echo \\`git push --force origin main\\``\"",
  "x='a'\"$(git push --force origin main)\"'b'",
  "echo $\"$(git push --force origin main)\"",
  "[[ $(git push --force origin main) ]]",
  "select x in a; do git push --force origin main; done",
  "for i in 1; do git push --force origin main; done",
  "while git push --force origin main; do :; done",
  "case $x in *) git push --force origin main;; esac",
  "{ git push --force origin main; }",
  "! git push --force origin main",
  "rm -rf \"$(echo /etc)\"",
  "rm -rf $(echo /etc)",
  "rm -r -f ~/../../etc",
  "cd / && rm -rf etc",
  "cd .. ; cd .. ; rm -rf x",
  "rm -rf \"${HOME}\"",
  "rm -rf ~user",
  "rm -rf /tmp/../etc",
  "rm -rf \"$TMPDIR/../..\"",
  "D=/tmp/x; D=/etc; rm -rf $D",
  "git push origin +main",
  "git push origin :main",
  "git push --mirror",
  "gh pr merge 1",
  "npm publish",
  "pnpm publish",
  "gh api repos/o/r/pulls/1/merge -X PUT",
  "gh api --method=PUT repos/o/r/pulls/1/merge",
  "gh api -XPUT repos/o/r/pulls/1/merge",
  "gh api -f merge_method=squash repos/o/r/pulls/1/merge",
  "gh api -X DELETE repos/o/r",
  "gh api -X DELETE repos/o/r/git/refs/heads/main",
  "diskutil zeroDisk disk2",
  "diskutil secureErase 0 disk2",
  "diskutil partitionDisk disk2 GPT APFS X 100%",
  "asr restore --source a --target /dev/disk2 --erase",
  "dd if=/dev/zero of=/dev/rdisk2",
  "cat /dev/zero >/dev/rdisk2",
];

const HARMLESS = [
  "git status",
  "git log --oneline -20",
  "git diff HEAD~1",
  "git commit -m \"fix: thing\"",
  "git checkout -b feat/x",
  "git rebase -i main",
  "git rebase main",
  "git stash push -m wip",
  "python3 - <<'E'\nprint(1)\nE\ngit stash push -q -- a.go; go vet ./a; git stash pop -q",
  "x=$(git rev-parse HEAD); git stash push -m \"$x\"",
  "git pull --rebase",
  "git add -A && git commit -m \"chore: x\"",
  "pnpm install",
  "pnpm test",
  "pnpm run build",
  "npm install",
  "npm test",
  "npm run lint -- --fix",
  "pnpm exec tsc --noEmit",
  "pnpm exec vitest run",
  "npx prettier --write .",
  "yarn install",
  "rm -rf node_modules",
  "rm -rf dist .next",
  "rm -rf node_modules dist && pnpm install",
  "rm -rf ./build/*",
  "docker build -t app .",
  "docker compose up -d",
  "docker compose down -v",
  "curl http://localhost:3000/health",
  "curl -s -X POST localhost:8080/api -H \"Content-Type: application/json\" -d '{\"a\":1}'",
  "grep -rn \"TODO\" src",
  "sed -i \"\" \"s/a/b/\" src/x.ts",
  "find . -name \"*.log\" -delete",
  "find src -name \"*.ts\" | xargs wc -l",
  "node -e \"console.log(process.version)\"",
  "cat <<EOF > notes.txt\nhello $(date)\nEOF",
  "gh pr view 12",
  "gh pr list",
  "gh pr create --draft --title x --body y",
  "ls -la && pwd",
  "echo $((1<<3))",
  "cat <<'EOF' > x.sh\nrm -rf /\ngit push -f\nEOF",
  "git log --format=\"%h %s\" | head",
  "tsc -p . && node dist/index.js",
  "for f in src/*.ts; do echo \"$f\"; done",
  "x=$(git rev-parse HEAD); echo \"$x\"",
  "out=\"$(pnpm test 2>&1)\"; echo \"$out\" | tail",
  "git branch -D old-feature",
  "git push --dry-run",
  "kill %1",
  "jobs",
  'D=$(mktemp -d) && cd "$D" && rm -rf x',
  'rm -rf $(pwd)/dist',
  'git commit -m "fix: handle the \\r case"',
  'echo "a b" | sed -n 1p',
  'ls $(git rev-parse --show-toplevel)',
  'cat <<EOF > out.txt\nhello \$HOME\nEOF',
];

test('R4: every silent bypass of the re-audit now asks', () => {
  for (const command of ASKS) {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, `should ask: ${JSON.stringify(command)}`);
  }
});

test('R4: the everyday commands stay silent', () => {
  for (const command of HARMLESS) assert.deepEqual(decide(command, ctx), { allow: true }, `should allow: ${JSON.stringify(command)}`);
});

test('R4: a carriage return is an ordinary character of the word, not whitespace', () => {
  assert.deepEqual(lexShell('echo x\r# hi').rawSegs, [['echo', 'x\r#', 'hi']]);
  assert.equal(decide('echo x\r# "$(git push --force origin main)"', ctx).ask, true);
});

test('R4: a heredoc delimiter has quotes and backslashes removed from the whole word', () => {
  for (const operator of ['<<"E"OF', '<<E"OF"', '<<E\\OF', "<<'E'OF", '<<EOF']) {
    const stripped = lexShell(`cat ${operator}\nbody\nEOF\nnext`).stripped;
    assert.equal(stripped.endsWith('\nnext'), true, operator);
    assert.equal(stripped.includes('body'), false, `${operator}: the body is data`);
  }
});

test('R4: a quoted-delimiter heredoc at top level is data; an unquoted one with an expansion is not', () => {
  assert.deepEqual(decide("cat <<'EOF' > x.sh\nrm -rf /\ngit push -f\nEOF", ctx), { allow: true });
  assert.equal(decide('cat <<EOF\n$(git push --force)\nEOF', ctx).ask, true);
  assert.equal(riskyWordInExpansion("bash <<'EOF'\nx\ngit push -f\nEOF"), 'risky word inside shell expansion'); // R5: only cat/tee read a body as data
});

test('R4: the reason is DESTRUCTIVE for rm and disk words, plain for the rest', () => {
  assert.equal(riskyWordInExpansion('x="$(rm -rf /)"'), 'DESTRUCTIVE: risky word inside shell expansion');
  assert.equal(riskyWordInExpansion('echo `dd if=/dev/zero of=x.img`'), 'DESTRUCTIVE: risky word inside shell expansion');
  assert.equal(riskyWordInExpansion('echo $(git push -f)'), 'risky word inside shell expansion');
  assert.equal(riskyWordInExpansion('echo $(date)'), undefined);
  assert.equal(riskyWordInExpansion('git push -f'), undefined, 'no hidden construct: the precise checks decide');
});

test('R4: a command over 32 KB asks "command too long to check" and is decided fast; the log keeps 2 KB, masked', () => {
  const huge = `echo ${'a'.repeat(500_000)}`;
  const started = performance.now();
  const r = decide(huge, ctx);
  assert.ok(performance.now() - started < 500, 'decided in under 500 ms');
  assert.equal(r.ask, true);
  assert.match(r.reason, /command too long to check/);
  const dir = mkdtempSync(join(tmpdir(), 'guard-r4-'));
  const file = join(dir, 'guard.jsonl');
  const secret = `ghp_${'A1'.repeat(18)}`;
  logDecision({ hook: 'pre-bash', tool: 'Bash', decision: 'ask', reason: r.reason, command: `${secret} ${huge}` }, { CLAUDE_GUARD_LOG: file });
  const line = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.ok(line.command.length <= 200);
  assert.equal(line.command.includes(secret), false);
});

test('R4: hostile 500 KB inputs of every shape decide in under 500 ms', () => {
  const shapes = ['curl '.repeat(100_000), 'aKEY'.repeat(125_000), 'a-'.repeat(250_000), 'x://a:'.repeat(80_000), '$('.repeat(250_000), "'".repeat(500_000)];
  for (const command of shapes) {
    const started = performance.now();
    decide(command, ctx);
    assert.ok(performance.now() - started < 500, `${command.slice(0, 12)} took too long`);
  }
});

const asksWith = (commands, pattern) => {
  for (const command of commands) {
    const r = decide(command, ctx);
    assert.equal(r.ask, true, `should ask: ${JSON.stringify(command)}`);
    if (pattern) assert.match(r.reason, pattern, command);
  }
};
const allowsAll = (commands) => {
  for (const command of commands) assert.deepEqual(decide(command, ctx), { allow: true }, `should allow: ${JSON.stringify(command)}`);
};

test('R4/D: prod SQL with a dollar quote, a backslash escape or a second statement is not read-only', () => {
  for (const sql of ['select 1 as x$a$; drop table t; -- $a$', 'select $$a$$', "select E'\\'' ; drop table t; --'", "select 'a\\'; drop table t; --'", 'select 1; select 2', 'select 1;drop table t'])
    assert.equal(isReadOnlySql(sql), false, sql);
  for (const sql of ['select 1', 'select 1;', 'select 1; -- done', '\\d users', "select 'a;b'"]) assert.equal(isReadOnlySql(sql), true, sql);
  asksWith(['psql -h db.prod.example.com -c \'select 1 as x$a$; drop table t; -- $a$\'', 'psql -h prod-db -c "select 1; select 2"'], /production host/);
  allowsAll(['psql -h prod-db -c "select count(*) from users"', 'psql -h db.prod.example.com -c "\\d users"']);
});

test('R4/E: PGHOST and friends set earlier in the same command line reach psql and mysql', () => {
  asksWith(['export PGHOST=db.prod.example.com\npsql -c "drop table t"', 'PGHOST=prod-db; psql -c "delete from t"', 'export MYSQL_HOST=prod-db && mysql -e "drop table t"', 'export PGSERVICE=prod; psql -c "update t set a = 1"'], /production host/);
  allowsAll(['export PGHOST=localhost\npsql -c "drop table t"', 'export PGHOST=db.prod.example.com\npsql -c "select 1"']);
});

test('R4/E: gh mutations, repo visibility, secrets and workflow runs ask; reads stay silent', () => {
  asksWith([
    "gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId} }'",
    'gh repo edit o/r --visibility public --accept-visibility-change-consequences',
    'gh secret set X -b v', 'gh secret delete X', 'gh workflow run deploy.yml',
  ]);
  allowsAll(["gh api graphql -f query='query { viewer { login } }'", 'gh repo edit o/r --description x', 'gh secret list', 'gh workflow list', 'gh workflow view ci.yml', 'gh run list']);
});

test('R4/E: diskutil apfs delete, and cp/mv/tee/dd/redirect onto a raw device ask as DESTRUCTIVE', () => {
  asksWith([
    'diskutil apfs deleteContainer disk2', 'diskutil apfs eraseVolume disk3s1', 'tee /dev/disk2 < /dev/zero', 'cp /dev/zero /dev/disk2', 'mv x /dev/sda',
    'dd if=/dev/zero of=/dev/rdisk2', 'cat /dev/zero >/dev/rdisk2', 'cp img.bin /dev/nvme0n1', 'echo x | tee /dev/sdb',
  ], DESTRUCTIVE);
  allowsAll(['diskutil list', 'diskutil apfs list', 'diskutil info disk0', 'cp /dev/disk2 img.bin', 'cp a b', 'tee out.log < in.log', 'cat /dev/zero | head -c 10 > /dev/null', 'dd if=/dev/zero of=img.bin bs=1m count=1']);
});

test('R4/E: an alias whose body would ask is asked about when it is defined', () => {
  asksWith(["alias p='git push -f'\np", "alias deploy='npm publish'"]);
  allowsAll(["alias ll='ls -la'", 'alias gs="git status"']);
});

// Tests for the commands git itself runs (home/hooks/lib/git-runs.mjs) as the Bash guard checks them: shell text given to a subcommand
// option (`rebase -x`), a word list (`bisect run`, `submodule foreach`, `for-each-repo`), config set for the call (`-c`, `--config-env`,
// GIT_CONFIG_*), environment assigned in front of git (GIT_SSH_COMMAND ...) and `ext::` URLs. Each inner command gets exactly the reasons
// it gets alone, plus the form's own; harmless ones stay silent; what the guard cannot read asks; hostile input stays fast. The forms
// follow the installed git 2.54 (its docs, and probes with `echo`). Command strings are only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { GIT_UNREADABLE_REASON } from '../home/hooks/lib/git-runs.mjs';
import { MAX_COMMAND_CHARS } from '../home/hooks/lib/verdict.mjs';
import { decide } from '../home/hooks/pre-bash-guard.mjs';
import { fastestMs } from './timing.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const GITHUB = `ghp_${'a1B2c3D4e5'.repeat(3)}`; // built from parts, so this file holds nothing that looks like a real token
const PUSH = 'git push -f origin main';
const RM = 'rm -rf ~/x';
const SECRET = `echo ${GITHUB}`;
const HARMLESS = 'pnpm test';
const FORCE_PUSH = /^DESTRUCTIVE: force push overwrites remote history/;
const RM_OUTSIDE = /^DESTRUCTIVE: rm -r outside the project/;
const RISKY = /risky word inside shell expansion/;

const reasonsOf = (command) => decide(command, ctx).reasons ?? [];
const reasonOf = (command) => decide(command, ctx).reason ?? '';
const sorted = (reasons) => [...new Set(reasons)].sort();

/**
 * Each form wraps an inner command (`(inner) => command line`). With a harmless inner command it gives only its own reasons (none, the
 * alias ask or the push ask); with a force push, an rm -r outside the project or a literal secret it adds exactly what that command
 * gets alone.
 */
function assertForms(forms, ownReasons = [], inners = [PUSH, RM, SECRET]) {
  for (const [name, form] of Object.entries(forms)) {
    assert.deepEqual(sorted(reasonsOf(form(HARMLESS))), sorted(ownReasons), `${name}: harmless`);
    for (const inner of inners) {
      assert.deepEqual(sorted(reasonsOf(form(inner))), sorted([...reasonsOf(inner), ...ownReasons]), `${name}: ${inner}`);
    }
  }
}

const FILTERS = ['setup', 'env-filter', 'tree-filter', 'index-filter', 'parent-filter', 'msg-filter', 'commit-filter', 'tag-name-filter'];
const SEND_EMAIL = ['sendmail-cmd', 'to-cmd', 'cc-cmd', 'header-cmd', 'smtp-server'];
// shell text given to an option of a subcommand (`--ex` and `-x<cmd>`, `clone --u`, `grep -O<pager>` were probed on git 2.54)
const OPTION_FORMS = {
  'rebase -x': (c) => `git rebase -x '${c}' main`, 'rebase --exec': (c) => `git rebase --exec '${c}' main`,
  'rebase --exec=': (c) => `git rebase -i --exec='${c}' main`, 'rebase --ex (a prefix)': (c) => `git rebase --ex '${c}' main`,
  'rebase -x<cmd>': (c) => `git rebase -x'${c}' main`, 'rebase -ix (a cluster)': (c) => `git rebase -ix '${c}' main`,
  'am --exec (not in git 2.54)': (c) => `git am --exec '${c}' a.patch`,
  'difftool -x': (c) => `git difftool -x '${c}' HEAD~1`, 'difftool --extcmd=': (c) => `git difftool --extcmd='${c}'`,
  'grep -O<pager>': (c) => `git grep -O'${c}' needle`, 'grep --open-files-in-pager=': (c) => `git grep --open-files-in-pager='${c}' needle`,
  'clone -u': (c) => `git clone -u '${c}' ../src dst`, 'clone --upload-pack=': (c) => `git clone --upload-pack='${c}' ../src dst`,
  'clone --u (a prefix)': (c) => `git clone --u '${c}' ../src dst`, 'fetch --upload-pack': (c) => `git fetch --upload-pack '${c}' ../src`,
  'pull --upload-pack': (c) => `git pull --upload-pack '${c}' ../src`, 'ls-remote --upload-pack=': (c) => `git ls-remote --upload-pack='${c}' ../src`,
  'ls-remote --exec=': (c) => `git ls-remote --exec='${c}' ../src`, 'fetch-pack --exec=': (c) => `git fetch-pack --exec='${c}' ../src`,
  'send-pack --receive-pack=': (c) => `git send-pack --receive-pack='${c}' ../dst`,
  'archive --exec=': (c) => `git archive --remote=../src --exec='${c}' HEAD`, 'daemon --access-hook=': (c) => `git daemon --access-hook='${c}'`,
  ...Object.fromEntries(FILTERS.map((option) => [`filter-branch --${option}`, (c) => `git filter-branch --${option} '${c}' HEAD`])),
  ...Object.fromEntries(SEND_EMAIL.map((option) => [`send-email --${option}=`, (c) => `git send-email --${option}='${c}' 0001.patch`])),
};
const PUSH_FORMS = { 'push --receive-pack=': (c) => `git push --receive-pack='${c}' ../dst`, 'push --exec': (c) => `git push --exec '${c}' ../dst` };
// word lists: bisect quotes every word, submodule foreach runs its first word as shell text with the rest as its arguments (both probed)
const LIST_FORMS = {
  'bisect run': (c) => `git bisect run ${c}`, 'submodule foreach': (c) => `git submodule foreach '${c}'`,
  'submodule foreach --recursive': (c) => `git submodule foreach --recursive '${c}'`, 'submodule --quiet foreach <words>': (c) => `git submodule --quiet foreach ${c}`,
};
// config keys whose value git runs (git 2.54 `git help config`, git-hook, git-archive); section and key in any case, any subsection
const COMMAND_KEYS = ['core.pager', 'pager.log', 'core.editor', 'sequence.editor', 'core.sshCommand', 'core.fsmonitor', 'core.askPass',
  'core.gitProxy', 'core.alternateRefsCommand', 'credential.helper', 'credential.https://example.com.helper', 'diff.external', 'diff.lfs.textconv',
  'diff.tool1.command', 'merge.ours.driver', 'mergetool.kdiff.cmd', 'mergetool.kdiff.path', 'difftool.kdiff.cmd', 'difftool.kdiff.path',
  'filter.lfs.clean', 'filter.lfs.smudge', 'filter.lfs.process', 'gpg.program', 'gpg.ssh.program', 'gpg.ssh.defaultKeyCommand',
  'sendemail.sendmailCmd', 'sendemail.toCmd', 'sendemail.work.ccCmd', 'sendemail.headerCmd', 'sendemail.smtpServer', 'uploadpack.packObjectsHook',
  'remote.origin.uploadpack', 'remote.origin.receivepack', 'browser.ff.cmd', 'browser.ff.path', 'man.woman.cmd', 'man.woman.path', 'instaweb.httpd',
  'interactive.diffFilter', 'gc.recentObjectsHook', 'guitool.lint.cmd', 'imap.tunnel', 'trailer.sign.command', 'trailer.sign.cmd',
  'tar.tgz.command', 'hook.lint.command', 'CORE.PAGER', 'Core.SshCommand', 'DIFF.Lfs.TEXTCONV'];
const CONFIG_FORMS = {
  ...Object.fromEntries(COMMAND_KEYS.map((key) => [`-c ${key}`, (c) => `git -c '${key}=${c}' log`])),
  '-c credential.helper=!': (c) => `git -c 'credential.helper=!${c}' fetch`,
  '-c submodule.<name>.update=!': (c) => `git -c 'submodule.lib.update=!${c}' submodule update`,
  '--config-env, its variable in front of git': (c) => `P='${c}' git --config-env core.pager=P log`,
  '--config-env=, its variable earlier in the line': (c) => `export P='${c}'; git --config-env=core.pager=P log`,
  'GIT_CONFIG_PARAMETERS': (c) => `GIT_CONFIG_PARAMETERS="'core.pager'='${c}'" git log`,
  'env GIT_CONFIG_PARAMETERS, older quoting': (c) => `env GIT_CONFIG_PARAMETERS="'core.editor=${c}'" git commit`,
};
// GIT_CONFIG_KEY_<n>=... already asks on main (the secret rule reads a literal assigned to a name with KEY in it); that ask stays
const KEY_ASSIGNMENT = reasonsOf('GIT_CONFIG_KEY_0=core.pager true');
const NUMBERED_CONFIG_FORMS = {
  'GIT_CONFIG_COUNT/KEY_0/VALUE_0': (c) => `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager GIT_CONFIG_VALUE_0='${c}' git log`,
  'GIT_CONFIG_KEY_1, an editor': (c) => `GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=color.ui GIT_CONFIG_VALUE_0=never GIT_CONFIG_KEY_1=Core.Editor GIT_CONFIG_VALUE_1='${c}' git commit`,
};
// clone's own -c|--config sets config in the new repository, used during the clone (`git help clone`); no other subcommand has one
const CLONE_CONFIG_FORMS = {
  'clone -c': (c) => `git clone -c 'core.sshCommand=${c}' ../src dst`, 'clone -qc (a cluster)': (c) => `git clone -qc 'core.sshCommand=${c}' ../src dst`,
  'clone --config=': (c) => `git clone --config='core.sshCommand=${c}' ../src dst`, 'clone --config': (c) => `git clone --config 'core.fsmonitor=${c}' ../src dst`,
};
// `git config` writing a command-running key is checked like -c, though git runs the value later
const CONFIG_WRITE_FORMS = {
  'config <key> <value>': (c) => `git config core.editor '${c}'`, 'config set': (c) => `git config set core.editor '${c}'`,
  'config --global': (c) => `git config --global core.pager '${c}'`, 'config --file <f>': (c) => `git config --file .git/config core.fsmonitor '${c}'`,
  'config --local --add': (c) => `git config --local --add sequence.editor '${c}'`,
  'config --worktree --replace-all': (c) => `git config --worktree --replace-all core.sshCommand '${c}'`,
  'config --type=path, a subsection': (c) => `git config --type=path diff.lfs.textconv '${c}'`, 'config alias.x !': (c) => `git config alias.st '!${c}'`,
};
// an alias runs `!<shell text>`; the alias ask of main stays
const ALIAS_FORMS = {
  '-c alias.x=!': (c) => `git -c 'alias.x=!${c}' x`, '-c alias.x.command=!': (c) => `git -c 'alias.x.command=!${c}' x`,
  '--config-env alias.x=': (c) => `A='!${c}' git --config-env alias.x=A x`, '-c ALIAS.X=!': (c) => `git -c 'ALIAS.X=!${c}' x`,
};
const ENV_NAMES = ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER', 'PAGER', 'EDITOR', 'VISUAL', 'GIT_EXTERNAL_DIFF',
  'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND'];
const ENV_FORMS = {
  ...Object.fromEntries(ENV_NAMES.map((name) => [name, (c) => `${name}='${c}' git fetch`])),
  'env NAME=': (c) => `env GIT_SSH_COMMAND='${c}' git fetch`, 'export NAME=; git': (c) => `export GIT_PAGER='${c}'; git log`,
  'NAME=; git': (c) => `GIT_EDITOR='${c}'; git commit`,
};
// git-remote-ext splits the command at spaces itself (`% ` is a space inside a word)
const EXT_FORMS = {
  'clone ext::': (c) => `git clone 'ext::${c}' dst`, 'fetch ext::': (c) => `git fetch 'ext::${c}' main`,
  'remote add ext::': (c) => `git remote add up 'ext::${c}'`, '-c remote.<name>.url=ext::': (c) => `git -c 'remote.up.url=ext::${c}' fetch up`,
  '--config-env remote.<name>.url=': (c) => `U='ext::${c}' git --config-env remote.up.url=U fetch up`, // the URL is in no word of git's
  'remote set-url ext::': (c) => `git remote set-url up 'ext::${c}'`, 'remote-ext, the helper itself': (c) => `git remote-ext up '${c}'`,
};

test('a command given to a subcommand option gets exactly the verdict it gets alone', () => {
  assertForms(OPTION_FORMS);
  assertForms(PUSH_FORMS, reasonsOf('git push ../dst'));
});

test('a word list git runs (bisect run, submodule foreach) gets exactly the verdict it gets alone', () => assertForms(LIST_FORMS));

test('config set for the call (-c, --config-env, GIT_CONFIG_*) whose value git runs gets exactly the verdict of that value', () => {
  assertForms(CONFIG_FORMS);
  assertForms(NUMBERED_CONFIG_FORMS, KEY_ASSIGNMENT, [PUSH, RM]);
  // the secret rule names one secret per command line: the token inside wins over the KEY assignment
  for (const form of Object.values(NUMBERED_CONFIG_FORMS)) assert.deepEqual(reasonsOf(form(SECRET)), reasonsOf(SECRET));
  assertForms(ALIAS_FORMS, reasonsOf('git -c alias.x=status x'));
});

test('clone -c|--config and git config writes: a command-running value gets exactly the verdict it gets alone', () => {
  assertForms(CLONE_CONFIG_FORMS);
  assertForms(CONFIG_WRITE_FORMS);
});

test('git config: reads and ordinary writes stay quiet; a hooks path asks like -c; an alias without ! is git arguments', () => {
  const quiet = ['git config --get core.editor', 'git config get core.editor', 'git config list', 'git config --list --show-origin',
    'git config user.name x', 'git config core.pager cat', 'git config core.editor "code --wait"', 'git config --global alias.co checkout',
    'git config --unset core.pager', 'git config protocol.file.allow always', 'git config --global --get-regexp alias'];
  for (const command of quiet) assert.deepEqual(decide(command, ctx), { allow: true }, command);
  const hooksPath = 'git -c core.hooksPath bypasses the git hooks';
  for (const command of ['git config core.hooksPath /dev/null', 'git config set --global core.hooksPath .githooks',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git commit']) {
    assert.ok(reasonsOf(command).includes(hooksPath), command);
  }
  assert.match(reasonOf(`git config alias.p '${PUSH.slice(4)}'`), FORCE_PUSH);
  assert.deepEqual(reasonsOf('git config protocol.ext.allow always'), [GIT_UNREADABLE_REASON]);
});

test('a git-run variable or config value set from what the guard cannot read asks, only next to a dangerous word', () => {
  const doubled = `A0='${RM}'; A1="$A0$A0"`;
  const hidden = [`${doubled}; GIT_EDITOR="$A1" git commit`, `${doubled}; git -c core.editor="$A1" commit`,
    `printf -v GIT_EDITOR %s '${RM}'; export GIT_EDITOR; git commit`, `printf -v E %s '${RM}'; git config core.editor "$E"`,
    `${doubled}; git clone -c core.sshCommand="$A1" ../src dst`];
  for (const command of hidden) assert.deepEqual(reasonsOf(command), [GIT_UNREADABLE_REASON], command);
  // lib/git-run-values.mjs reads these values wherever they are assigned, git or not: the value's own reason
  for (const command of [`declare -x GIT_EDITOR='${RM}'; git commit`, `typeset -x GIT_SSH_COMMAND='${RM}'; git fetch`, `A0='${RM}'; EDITOR="$A0" true`]) {
    assert.match(reasonOf(command), RM_OUTSIDE, command);
  }
  const quiet = ['GIT_EDITOR="$EDITOR" git commit', 'git -c core.editor="$EDITOR" commit', 'declare -x GIT_EDITOR=vim; git commit',
    'GIT_EDITOR=vim git commit && rm -rf /tmp/build', `A0='${RM}'; echo "$A0"`,
    'git commit -e; echo "$EDITOR" && rm -rf /tmp/build']; // no git run / only reads the variable
  for (const command of quiet) assert.deepEqual(decide(command, ctx), { allow: true }, command);
  // printf -v writes a variable git runs out of sight, whatever it prints (lib/git-run-values.mjs)
  assert.deepEqual(reasonsOf('printf -v GIT_EDITOR %s vim; export GIT_EDITOR; git commit'), [GIT_UNREADABLE_REASON]);
});

test('an environment variable git runs, set in front of git or earlier in the line, gets exactly the verdict of its value', () => assertForms(ENV_FORMS));

test('an ext:: URL runs its command: checked word by word as git-remote-ext splits it', () => {
  assertForms(EXT_FORMS);
  assert.match(reasonOf("git clone 'ext::sh -c rm% -rf% ~/x' dst"), RM_OUTSIDE);
  assert.deepEqual(decide("git clone 'ext::ssh -i key git@example.com %S repo' dst", ctx), { allow: true });
  assert.match(reasonOf(`printf 'connect git-upload-pack\\n' | git remote-ext up 'sh -c rm% -rf% ~/x'`), RM_OUTSIDE);
  assert.deepEqual(decide("git remote-fd up 'fd::3,4'", ctx), { allow: true }); // remote-fd talks over file descriptors: no command
});

test('for-each-repo runs git with its words in other repositories: checked as that git command, relative paths unknown', () => {
  assert.deepEqual(decide('git for-each-repo --config=maintenance.repo maintenance run --task=gc', ctx), { allow: true });
  for (const command of [`git for-each-repo --config=maintenance.repo ${PUSH.slice(4)}`, `git for-each-repo --config r --keep-going -- ${PUSH.slice(4)}`]) {
    assert.deepEqual(sorted(reasonsOf(command)), sorted(reasonsOf(PUSH)), command);
  }
  assert.match(reasonOf("git for-each-repo --config=r -- -c 'alias.y=!rm -rf build' y"), RM_OUTSIDE);
  // an option for-each-repo does not know (git 2.54 rejects it) is read as git's own, both ways: -c sets config, --future may take x
  assert.match(reasonOf("git for-each-repo --config=r -c 'alias.y=!rm -rf build' y"), RM_OUTSIDE);
  assert.match(reasonOf(`git for-each-repo --conf r --no-keep --future x ${PUSH.slice(4)}`), FORCE_PUSH);
});

test('config the guard reads only in part: a name that is a variable, a GIT_CONFIG_VALUE_n without its key, remote.<name>.vcs', () => {
  assert.match(reasonOf(`git -c "$K=${RM}" log`), RM_OUTSIDE); // the name may be core.pager
  assert.match(reasonOf(`GIT_CONFIG_COUNT=1 GIT_CONFIG_VALUE_0='${RM}' git log`), RM_OUTSIDE); // the key may be set outside the line
  // git runs the program git-remote-<vcs> without a shell; reading the value as shell text after `git remote-` is the safe side
  assert.deepEqual(decide('git -c remote.up.vcs=hg fetch up', ctx), { allow: true });
  assert.match(reasonOf(`git -c 'remote.up.vcs=x; ${RM}' fetch up`), RM_OUTSIDE);
});

test('an alias without ! is git arguments: a force push behind it is a force push, besides the alias ask', () => {
  for (const command of [`git -c 'alias.p=${PUSH.slice(4)}' p`, `git -c 'alias.p.command=${PUSH.slice(4)}' p`, `A='${PUSH.slice(4)}' git --config-env=alias.p=A p`]) {
    assert.match(reasonOf(command), FORCE_PUSH, command);
    assert.match(reasonOf(command), /git -c alias\.\* defines a command for this call/, command);
  }
});

test('the three audit inputs ask: rebase -x of a force push, bisect run of rm -rf, a pager that deletes', () => {
  for (const command of [`git rebase -x '${PUSH}' HEAD~1`, `git rebase --exec '${PUSH}' HEAD~1`, `git rebase --exec='${PUSH}' HEAD~1`]) {
    assert.match(reasonOf(command), FORCE_PUSH, command);
  }
  assert.match(reasonOf('git bisect run rm -rf ~/x'), RM_OUTSIDE);
  assert.match(reasonOf(`git -c core.pager='${RM}' log`), RM_OUTSIDE);
});

test('combined forms: -C before an alias, alias to alias, an alias that runs rebase -x, a bash -c inside --exec', () => {
  assert.match(reasonOf("git -C x -c alias.y='!rm -rf ~' y"), RM_OUTSIDE);
  assert.match(reasonOf(`git -c alias.a=b -c 'alias.b=${PUSH.slice(4)}' a`), FORCE_PUSH);
  assert.match(reasonOf(`git -c "alias.a=-c alias.b='!${RM}' b" a`), RM_OUTSIDE);
  assert.match(reasonOf(`git -c "alias.r=rebase -x '${PUSH}'" r main`), FORCE_PUSH);
  assert.match(reasonOf(`git rebase -x "bash -c '${RM}'" main`), RM_OUTSIDE);
  assert.match(reasonOf(`git submodule foreach "git -c core.pager='${RM}' log"`), RM_OUTSIDE);
});

test('a command git runs in another directory (-C, --git-dir, GIT_WORK_TREE) has its relative rm -r paths judged there', () => {
  assert.deepEqual(decide("git rebase -x 'rm -rf build' main", ctx), { allow: true });
  assert.deepEqual(decide("git -C sub rebase -x 'rm -rf build' main", ctx), { allow: true });
  for (const command of ["git -C ~ rebase -x 'rm -rf build' main", "git -C /etc rebase -x 'rm -rf build' main", "git --git-dir=/x/.git rebase -x 'rm -rf build' main",
    "GIT_WORK_TREE=/x git rebase -x 'rm -rf build' main", "git -C \"$D\" rebase -x 'rm -rf build' main"]) {
    assert.match(reasonOf(command), RM_OUTSIDE, command);
  }
});

test('what the guard cannot read asks: a --config-env variable not set in the line, a GIT_CONFIG_KEY_n alone, ext:: switched on', () => {
  const unreadable = ['git --config-env core.pager=MY_PAGER log', 'git --config-env=core.sshCommand=SSH_CMD fetch', 'git -c protocol.ext.allow=always fetch origin', 'git -c protocol.allow=always submodule update', 'git -c Protocol.Ext.Allow=user clone x y',
    'GIT_ALLOW_PROTOCOL=https:ext git fetch origin'];
  for (const command of unreadable) assert.deepEqual(reasonsOf(command), [GIT_UNREADABLE_REASON], command);
  const keyAlone = 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.pager git log';
  assert.deepEqual(sorted(reasonsOf(keyAlone)), sorted([...KEY_ASSIGNMENT, GIT_UNREADABLE_REASON]));
  // the user's own editor or pager variable, ext:: switched off, and other protocols stay silent
  const silent = ['git --config-env core.editor=EDITOR commit', 'git --config-env core.pager=PAGER log', 'git -c protocol.ext.allow=never fetch',
    'git -c protocol.file.allow=always submodule update --init', 'GIT_ALLOW_PROTOCOL=https:ssh git fetch'];
  for (const command of silent) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('a config value that is a variable or substitution asks only where raw-risk would; an environment value that is a substitution asks', () => {
  for (const command of ['GIT_PAGER="$P" git log', 'git -c core.pager="$MY_PAGER" log', 'git -c core.sshCommand="ssh -i $KEY" fetch']) {
    assert.deepEqual(decide(command, ctx), { allow: true }, command);
  }
  assert.deepEqual(reasonsOf('GIT_SSH_COMMAND="$(cat ssh-cmd)" git fetch'), [GIT_UNREADABLE_REASON]); // lib/git-run-values.mjs
  assert.match(reasonOf(`P='${RM}'; git -c core.pager="$P" log`), RM_OUTSIDE); // a variable assigned in the line is read
  assert.deepEqual(reasonsOf('git --config-env core.pager=P log; P=less'), [GIT_UNREADABLE_REASON]); // assigned only after git ran
  assert.match(reasonOf(`GIT_PAGER="$(echo ${RM})" git log`), RISKY);
  assert.deepEqual(sorted(reasonsOf('git rebase -x "$CMD" main')), sorted(reasonsOf('$CMD')));
});

test('config read from a file the guard cannot read (GIT_CONFIG_GLOBAL|SYSTEM, include.path) asks only next to a dangerous word', () => {
  const written = `printf '[core]\\n\\tpager = ${RM}\\n' > /tmp/c.cfg`;
  for (const reads of ['GIT_CONFIG_GLOBAL=/tmp/c.cfg git log', 'GIT_CONFIG_SYSTEM=/tmp/c.cfg git log', 'git -c include.path=/tmp/c.cfg log',
    'git -c includeIf.onbranch:main.path=/tmp/c.cfg log', 'export GIT_CONFIG_GLOBAL=/tmp/c.cfg; git log']) {
    assert.deepEqual(reasonsOf(`${written}; ${reads}`), [GIT_UNREADABLE_REASON], reads); // no rewrite helps: the owner confirms
    assert.deepEqual(decide(reads, ctx), { allow: true }, reads);
  }
  assert.deepEqual(decide(`${written}; GIT_CONFIG_GLOBAL=/dev/null git log`, ctx), { allow: true }); // /dev/null is read: it is empty
});

test('ordinary commands stay silent (no false alarms)', () => {
  const ordinary = ['git -c core.pager=cat log', 'git -c color.ui=never status', 'GIT_PAGER=cat git diff', 'GIT_EDITOR=true git rebase --continue',
    "git rebase -x 'pnpm test' main", 'git bisect run npm test', 'git submodule foreach git status', "GIT_SSH_COMMAND='ssh -i key' git fetch",
    "git -c core.sshCommand='ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes' fetch", "git -c core.editor='code --wait' commit", 'EDITOR=vim git commit',
    'git -c credential.helper=store fetch', 'git -c credential.helper= fetch', 'git -c protocol.file.allow=always submodule update --init',
    'git log --ext-diff', 'git -c diff.tool=vimdiff difftool HEAD~1', 'git grep -O needle', 'git grep -n -e needle', 'GIT_CONFIG_GLOBAL=/dev/null git status',
    'git -c url.https://github.com/.insteadOf=git@github.com: fetch', 'git rebase -i HEAD~3', 'git clone --depth 1 https://github.com/a/b',
    'git -c pager.log=false log', 'git filter-branch --subdirectory-filter lib -- --all', 'git -c gpg.format=ssh commit -S -m x',
    'git bisect run npm test > bisect.log 2>&1', 'git submodule foreach --recursive git pull --rebase', 'git push --dry-run'];
  for (const command of ordinary) assert.deepEqual(decide(command, ctx), { allow: true }, command);
});

test('hostile input stays bounded: ambiguous readings ask, chains stop at MAX_NESTING, 32 KB of forms decide in seconds', () => {
  const readings = `git ${'--f submodule --quiet foreach '.repeat(900)}${RM}`; // every reading of the unknown option runs another list
  const forEachRepo = `git ${'--f for-each-repo -- '.repeat(1300)}${PUSH.slice(4)}`;
  const chain = `git ${'for-each-repo --config=r '.repeat(30)}${PUSH.slice(4)}`;
  const options = `git rebase ${`-x '${RM}' `.repeat(1900)}main`;
  const distinct = `git ${Array.from({ length: 1500 }, (_, i) => `-c core.pager=p${i}`).join(' ')} log`;
  for (const command of [readings, forEachRepo, chain, options, distinct]) assert.ok(command.length <= MAX_COMMAND_CHARS, 'parsed, not too long');
  assert.deepEqual(decide(distinct, ctx), { allow: true });
  assert.match(reasonOf(readings), /git runs a command this guard cannot read/);
  assert.match(reasonOf(forEachRepo), /git runs a command this guard cannot read/);
  assert.match(reasonOf(chain), /nested too deeply/);
  assert.match(reasonOf(`git ${'for-each-repo --config=r '.repeat(10)}${PUSH.slice(4)}`), FORCE_PUSH);
  assert.match(reasonOf(options), RM_OUTSIDE);
  const fastest = fastestMs(() => [readings, forEachRepo, chain, options, distinct].forEach((command) => decide(command, ctx)));
  assert.ok(fastest < 5000, `took too long (fastest of 3: ${fastest.toFixed(1)} ms)`);
});

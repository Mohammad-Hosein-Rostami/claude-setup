// Tests for shell forms that used to hide a command's words from the Bash guard (home/hooks/pre-bash-guard.mjs and its lib/): `NAME+=x`
// and `NAME[i]=x` in front of a command are assignments, not the command word (lib/command-of.mjs). Each case states the reading
// bash or zsh gives the line; the guard must judge that reading. The platform is injected by setting process.platform around each call,
// so the results do not depend on the machine the tests run on. Command strings are only passed to decide(); nothing is executed.
import './pin-home.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { decide } from '../home/hooks/pre-bash-guard.mjs';

const PROJECT = resolve('/work/proj');
const ctx = { cwd: PROJECT, project: PROJECT, prodHosts: [] };
const PLATFORMS = ['linux', 'darwin', 'win32'];

/** decide() as it runs on `platform`: process.platform is replaced for the call and restored after it. */
function decideOn(platform, command) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return decide(command, ctx);
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}
const reasonsOn = (platform, command) => decideOn(platform, command).reasons ?? [];
const quietOn = (platform, command) => assert.deepEqual(decideOn(platform, command), { allow: true }, `${platform}: ${command}`);

// one example per rule that reads the command word; each asks on its own (the audit's list of prefixed lines that turned into allows)
const RULE_EXAMPLES = ['find ~ -delete', 'eval "$Y"', 'su -c id', "env -S 'id'", "alias p='git push -f'", '"$CMD" -rf x',
  'HUSKY=0 git commit -m x', 'security find-generic-password -w -s x'];
const ASSIGNMENT_PREFIXES = ['X+=1', 'X[1]=1', 'X[i+1]+=a', 'arr[0]=a X+=b'];

test('NAME+=x and NAME[i]=x in front of a command are assignments: the command after them is judged as without them', () => {
  for (const platform of PLATFORMS) {
    for (const example of RULE_EXAMPLES) {
      const alone = reasonsOn(platform, example);
      assert.ok(alone.length > 0, `${platform}: ${example} asks on its own`);
      for (const prefix of ASSIGNMENT_PREFIXES) assert.deepEqual(reasonsOn(platform, `${prefix} ${example}`), alone, `${platform}: ${prefix} ${example}`);
    }
  }
});

test('the prefix forms are read inside eval, bash -c and su -c bodies too', () => {
  for (const line of ["eval 'X+=1 find ~ -delete'", "bash -c 'X[2]=1 find ~ -delete'", "X+=1 bash -c 'X+=1 find ~ -delete'"]) {
    assert.match(decideOn('linux', line).reason ?? '', /^DESTRUCTIVE: find deleting outside the project/, line);
  }
});

test('ordinary appends and array writes stay quiet', () => {
  for (const line of ['x+=1', 'arr[0]=a', 'files+=("$f")', 'X+=1 echo hi', 'PATH+=:/opt/bin npm test', 'arr[0]=a; echo "${arr[0]}"']) {
    for (const platform of PLATFORMS) quietOn(platform, line);
  }
});

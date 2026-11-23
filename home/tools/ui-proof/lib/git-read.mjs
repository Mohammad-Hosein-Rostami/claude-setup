// Purpose: read a project's files at a commit with git plumbing only (ls-tree, cat-file), for screens.mjs and reach.mjs.
// Exports: gitRun, readTree, readBlobs.
// Invariants (P2): nothing is checked out, run or written in the project; git runs with `--no-optional-locks`, GIT_SAFETY, no
// inherited GIT_* variables and a 5 s timeout per call; a failed call throws an Error that names the git command.
import { spawnSync } from 'node:child_process';
import { GIT_SAFETY } from '../../board/lib/git-state.mjs';

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 256 << 20;
const BLOBS_PER_CALL = 400;

const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));

/** Run read-only git in `repoDir` (fixed flags first). @returns {Buffer} stdout @throws {Error} naming the command on failure or timeout */
export function gitRun(repoDir, args, input = undefined, okStatuses = [0]) {
  const result = spawnSync('git', ['--no-optional-locks', ...GIT_SAFETY, '-C', repoDir, ...args],
    { input, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, env: gitEnv(), windowsHide: true });
  if (result.error || !okStatuses.includes(result.status)) {
    throw new Error(`git ${args[0]} failed: ${(result.error?.message ?? String(result.stderr ?? '')).trim().split('\n')[0]}`);
  }
  return result.stdout;
}

/** Every file at a commit. @returns {Map<string,{blob:string,size:number}>} repo path -> blob id and size (links and submodules left out) */
export function readTree(repoDir, sha) {
  const files = new Map();
  for (const entry of gitRun(repoDir, ['ls-tree', '-r', '-l', '-z', '--full-tree', sha]).toString('utf8').split('\0')) {
    const tab = entry.indexOf('\t');
    const [mode, type, blob, size] = entry.slice(0, tab).split(/ +/);
    if (tab > 0 && type === 'blob' && mode !== '120000') files.set(entry.slice(tab + 1), { blob, size: Number(size) });
  }
  return files;
}

/** The texts of blobs (one `cat-file --batch` per BLOBS_PER_CALL). @returns {Map<string,string>} blob id -> utf8 text */
export function readBlobs(repoDir, blobs) {
  const texts = new Map();
  const unique = [...new Set(blobs)];
  for (let start = 0; start < unique.length; start += BLOBS_PER_CALL) {
    const out = gitRun(repoDir, ['cat-file', '--batch'], `${unique.slice(start, start + BLOBS_PER_CALL).join('\n')}\n`);
    let at = 0;
    while (at < out.length) {
      const eol = out.indexOf(10, at);
      if (eol < 0) throw new Error('git cat-file gave a header without an end of line');
      const [blob, type, size] = out.subarray(at, eol).toString('utf8').split(' ');
      at = eol + 1;
      if (type === 'missing') continue; // `<id> missing`: no content follows
      if (!/^\d+$/.test(size ?? '')) throw new Error(`git cat-file gave a bad header for ${blob}`);
      if (type === 'blob') texts.set(blob, out.subarray(at, at + Number(size)).toString('utf8'));
      at += Number(size) + 1;
    }
  }
  return texts;
}

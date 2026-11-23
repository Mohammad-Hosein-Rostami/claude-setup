// Purpose: the `--history` check of scripts/share-check.mjs: per deny word, the commits of every ref whose message holds it and the
//   commits whose changes hold it, in the old or the new content of a changed file or in its path.
// Exports: checkHistory(cwd, denied, { git, fail }) -> the number of deny words found (prints one line per word and a summary).
// Invariants:
// - Every blob a commit's raw diff names (old and new side, root commits and each parent of a merge included) is read once with
//   `git cat-file --batch` and searched with the same matcher as the files (match.mjs), so UTF-16, binary, NFKC, zero-width, line-split
//   and camelCase cases hit in history as in the tree; `git log -G` would see none of them.
// - A commit counts for a word when its message holds it, or a blob or path of its changes does: a commit that removes the word
//   counts too (the old blob holds it), as does one that changes another line of a file that still holds it.
// - Read only; the output holds commit ids, counts and the deny word, never content. An object git cannot read fails (`fail`).
import { findHits, findHitsInBytes, nameWords } from './match.mjs';

const HISTORY_SHAS_SHOWN = 10; // short commit ids printed per word; the rest is counted
const SHORT_SHA = 12;
const COMMIT_MARK = '\x01'; // starts each commit id in the `--raw -z` log; raw entries start with `:`
const GITLINK_MODE = '160000'; // a submodule commit, not a blob
const NO_OBJECT = /^0+$/;
const NEWLINE = 0x0a;

/** Every commit of every ref with the blob ids and paths its changes touch, from one `git log --raw -z`. */
function commitChanges(cwd, { git, fail }) {
  const args = ['log', '--all', '--root', '-m', '--no-renames', '--raw', '--no-abbrev', '-z', `--format=${COMMIT_MARK}%H`];
  const tokens = git(cwd, args).toString('utf8').split('\0');
  const commits = new Map();
  let current;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/^\n/, '');
    if (token === '') continue;
    if (token.startsWith(COMMIT_MARK)) {
      current = commits.get(token.slice(1)) ?? { sha: token.slice(1), blobs: new Set(), paths: new Set() };
      commits.set(current.sha, current);
      continue;
    }
    if (!token.startsWith(':') || current === undefined || index + 1 >= tokens.length) throw fail(`git log --raw printed an entry it does not document`);
    const [oldMode, newMode, oldSha, newSha] = token.slice(1).split(' ');
    index += 1;
    current.paths.add(tokens[index]); // the path is the next NUL-separated field, whatever bytes it holds
    for (const [mode, sha] of [[oldMode, oldSha], [newMode, newSha]]) if (mode !== GITLINK_MODE && !NO_OBJECT.test(sha)) current.blobs.add(sha);
  }
  return [...commits.values()];
}

/** The deny words each blob holds, read in one `git cat-file --batch`. */
function blobWords(cwd, shas, denied, { git, fail }) {
  const words = new Map();
  if (shas.length === 0) return words;
  const out = git(cwd, ['cat-file', '--batch'], `${shas.join('\n')}\n`);
  for (let at = 0; at < out.length;) {
    const headerEnd = out.indexOf(NEWLINE, at);
    const [sha, type, size] = out.subarray(at, headerEnd === -1 ? undefined : headerEnd).toString('utf8').split(' ');
    if (headerEnd === -1 || type !== 'blob') throw fail(`history object ${sha} is not a readable blob`);
    const end = headerEnd + 1 + Number(size);
    words.set(sha, new Set(findHitsInBytes(out.subarray(headerEnd + 1, end), denied).map((hit) => hit.word)));
    at = end + 1; // the newline git prints after each object
  }
  return words;
}

/** Each commit's message, by full id. */
function commitMessages(cwd, git) {
  return git(cwd, ['log', '--all', '-z', '--format=%H%n%B']).toString('utf8').split('\0').filter((record) => record !== '').map((record) => {
    const cut = record.indexOf('\n');
    return { sha: record.slice(0, cut === -1 ? undefined : cut), text: cut === -1 ? '' : record.slice(cut + 1) };
  });
}

/**
 * Prints, per deny word, the commits whose message holds it and those whose changes hold it, then a summary line.
 * @param {string} cwd a folder inside the repository
 * @param {{word: string, pattern: RegExp}[]} denied the words with their patterns
 * @param {{git: (cwd: string, args: string[], input?: string) => Buffer, fail: (why: string) => Error}} tools share-check's git
 *   runner (throws on a failure) and its error maker
 * @returns {number} the number of words found (0: clean)
 */
export function checkHistory(cwd, denied, tools) {
  const messages = commitMessages(cwd, tools.git);
  const changes = commitChanges(cwd, tools);
  const blobs = blobWords(cwd, [...new Set(changes.flatMap((commit) => [...commit.blobs]))], denied, tools);
  const pathWords = new Map([...new Set(changes.flatMap((commit) => [...commit.paths]))].map((path) => [path, new Set(nameWords(path, denied))]));
  const holds = (commit, word) => [...commit.blobs].some((sha) => blobs.get(sha)?.has(word)) || [...commit.paths].some((path) => pathWords.get(path).has(word));
  let hitWords = 0;
  for (const entry of denied) {
    const inMessages = messages.filter(({ text }) => findHits(text, [entry]).length > 0).map(({ sha }) => sha);
    const inChanges = changes.filter((commit) => holds(commit, entry.word)).map(({ sha }) => sha);
    const commits = [...new Set([...inMessages, ...inChanges])];
    if (commits.length === 0) continue;
    hitWords += 1;
    const shown = commits.slice(0, HISTORY_SHAS_SHOWN).map((sha) => sha.slice(0, SHORT_SHA)).join(' ');
    const more = commits.length > HISTORY_SHAS_SHOWN ? ` +${commits.length - HISTORY_SHAS_SHOWN} more` : '';
    console.log(`share-check: history ${entry.word}: ${commits.length} commits (messages ${inMessages.length}, changes ${inChanges.length}): ${shown}${more}`);
  }
  const counts = `${messages.length} commits, ${denied.length} words`;
  console.log(hitWords === 0 ? `share-check: history clean (${counts})` : `share-check: history: ${hitWords} words found (${counts})`);
  return hitWords;
}

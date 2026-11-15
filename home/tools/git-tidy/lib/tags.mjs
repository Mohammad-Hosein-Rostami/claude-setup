// Purpose: tags that are not on the base's history: leftovers (all their work is on the base, typically a backup made before a
//   history clean-up) or tags on work the base lacks.
// Exports: classifyTags, isBackupTag.
// Invariants: a tag that is an ancestor of the base (a release tag on the line) is never returned; only tags of commits are
//   looked at; nothing is written.
import { compareWithBase } from './branches.mjs';
import { gitText } from './git.mjs';

// The name the history clean-up procedure gives its temporary tags. Only these are findings: whether any other tag is
// published cannot be known without the network (a release tag on a backport branch is normal), so those are hints.
const BACKUP_TAG_PREFIX = 'backup/';

/** True for a temporary backup tag (`backup/...`). */
export const isBackupTag = (name) => name.startsWith(BACKUP_TAG_PREFIX);

const FORMAT = ['%(refname:strip=2)', '%(objecttype)', '%(objectname)', '%(objectname:short)', '%(committerdate:short)', '%(*objecttype)', '%(*objectname)', '%(*objectname:short)', '%(*committerdate:short)'].join('%00');

/**
 * Tags whose commit is not an ancestor of the base, as `{ name, tip, short, date, state, ahead }`; `state` is `patch-equal`
 * (everything is on the base by the same test as for branches) or `unmerged`. An annotated tag is read through to its commit.
 */
export function classifyTags(repo) {
  const onBase = new Set(gitText(repo.dir, ['for-each-ref', `--merged=${repo.baseRef}`, '--format=%(refname:strip=2)', 'refs/tags']).split('\n'));
  const listed = gitText(repo.dir, ['for-each-ref', `--format=${FORMAT}`, 'refs/tags']);
  const tags = [];
  for (const line of listed === '' ? [] : listed.split('\n')) {
    const [name, type, object, short, date, peeledType, peeledObject, peeledShort, peeledDate] = line.split('\0');
    const annotated = peeledType !== '';
    if ((annotated ? peeledType : type) !== 'commit' || onBase.has(name)) continue;
    const tip = annotated ? peeledObject : object;
    const { state, ahead } = compareWithBase(repo, tip);
    tags.push({ name, tip, short: annotated ? peeledShort : short, date: annotated ? peeledDate : date, state, ahead });
  }
  return tags;
}

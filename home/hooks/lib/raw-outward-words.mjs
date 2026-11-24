// The outward words that lib/raw-risk.mjs looks for in the raw text of a command with a hidden construct: a gh mutation and a deploy
// or cloud verb. Exports: ghMutation(after) -> boolean, isDeployWord(word, after) -> boolean.
// Both read only the words that follow the tool's name in one statement (quote-stripped, as raw-risk gives them); a false positive costs
// a dialog. Pure, no I/O.
import { deployAsk } from './deploy.mjs';

const GH_VERBS = new Set(['merge', 'delete', 'archive', 'rename', 'transfer']);
const GH_READ_VERBS = new Set(['list', 'view', 'download']);
const GH_API_WORDS = new Set(['mutation', 'PUT', 'POST', 'PATCH', 'DELETE']);
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '--hostname']);

/**
 * `gh <group> <verb>` by position (flags skipped): `gh pr create --title "delete x"` is not a delete; `gh release create` and `gh pr merge` are.
 * @param {string[]} after the words after `gh` in one statement
 * @returns {boolean} true when the words may change something on GitHub
 */
export function ghMutation(after) {
  const positional = [];
  for (let i = 0; i < after.length && positional.length < 2; i++) {
    if (GH_VALUE_FLAGS.has(after[i])) i++;
    else if (!after[i].startsWith('-')) positional.push(after[i]);
  }
  const [group, verb = ''] = positional;
  if (group === 'api') return after.some((w) => GH_API_WORDS.has(w) || w.startsWith('-X') || /^--method/.test(w));
  if (group === 'release') return !GH_READ_VERBS.has(verb);
  if (group === 'repo' && verb === 'edit') return true;
  if ((group === 'secret' || group === 'variable') && /^(?:set|delete|remove)$/.test(verb)) return true;
  return (group === 'workflow' && verb === 'run') || GH_VERBS.has(verb);
}

/**
 * A deploy or cloud verb, read as the guard's own rule reads it (lib/deploy.mjs deployAsk): `kubectl apply`, `vercel --prod`.
 * @param {string} word one word of the statement, exact case
 * @param {string[]} after the words after it in the same statement
 * @returns {boolean} true when `word` is a deploy tool and `after` holds a verb that changes live infrastructure
 */
export const isDeployWord = (word, after) => deployAsk(word, after) !== undefined;

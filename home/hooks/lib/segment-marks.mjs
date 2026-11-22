// Flags the two shell parsers (shell-words.mjs tokenize, shell-lexer.mjs) put on a segment, so both give the same shape.
// Exports: markPiped, markJoin, markGlued, opensArrayList, markArrayList.
// Each flag is a non-enumerable property, so a segment still compares equal to a plain word list (moved out of shell-lexer.mjs, which was full).
// Invariants: pure apart from setting the flag on the array it is given.

/** Marks a segment as fed by `|`; non-enumerable, so segments still compare equal to plain word lists. */
export const markPiped = (seg) => Object.defineProperty(seg, 'piped', { value: true, configurable: true });
/** Records the operators that came before a segment's first word (`&&`, `;`, `(`, `)&&`, '' at the start); non-enumerable like `.piped`. Not named `join`: that would hide the array method. */
export const markJoin = (seg, join) => Object.defineProperty(seg, 'joinedBy', { value: join, configurable: true });
/**
 * Records, on the segment a `(` opened, the raw word that `(` touched with no blank between (`src/*(.)`: a zsh glob qualifier, N6).
 * lib/bare-glob.mjs reads it, so `src/* (/)` (apart: a group naming `/`) is never taken for `src/*(/)` written elsewhere on the line.
 */
export const markGlued = (seg, word) => Object.defineProperty(seg, 'gluedTo', { value: word, configurable: true });
// `NAME=(`, `NAME+=(`, `NAME[i]=(`: the list after it holds an array's elements, which are words, not a command
const ARRAY_ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=$/;
/** True when the `(` that follows the word `before` opens an array's element list (`files+=("$f")`). */
export const opensArrayList = (before) => ARRAY_ASSIGNMENT.test(before ?? '');
/** Marks a segment as an array's element list: the guard reads its words, but its first word is not a command word. */
export const markArrayList = (seg) => Object.defineProperty(seg, 'arrayList', { value: true, configurable: true });

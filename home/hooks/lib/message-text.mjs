// Message text is data: the quoted message argument of `git commit`, `gh pr create|edit|comment` and `gh issue create|edit|comment`
// (`-m`, `--message`, `--title`, `--body`, `-t`, `-b`, `--subject`, also `--flag="..."` and `-m"..."`) is blanked, so words such as
// `rm -rf` or `gh release` written in a commit or PR text do not look like commands to the raw-text rule (raw-risk.mjs).
// Exports: withoutMessageText(text) -> text with each safe message argument replaced by `"x"`.
// An argument is safe when it is single-quoted, or double-quoted with no `$(` and no backtick except a heredoc read by cat
// (`"$(cat <<'EOF' ... EOF\n)"`; an unquoted delimiter needs a body without `$(` or a backtick). Anything else is left as written, so it is
// still scanned. A quote that never closes stops the scan of that command. Pure; linear in the text length.
const MESSAGE_COMMAND = /\bgit(?:[ \t]+(?:-[Cc][ \t]+\S+|--[\w-]+(?:=\S*)?))*[ \t]+commit\b|\bgh[ \t]+(?:pr|issue)[ \t]+(?:create|edit|comment)\b/g;
const MESSAGE_FLAG = /^(?:-[a-zA-Z]*m|--message|--title|--body|--subject|-t|-b)$/;
const MESSAGE_FLAG_ATTACHED = /^(?:--(?:message|title|body|subject)=|-[a-zA-Z]*m)$/;
const STATEMENT_END = ';|&\n)';
const REDIRECT = '<>';
const CAT_HEREDOC = /\$\([ \t]*cat[ \t]*<<(-?)[ \t]*(?:'(\w+)'|"(\w+)"|\\(\w+)|(\w+))[ \t]*\n/y;
const HEREDOC_CLOSE = /[ \t]*\n?[ \t]*\)/y;
const EXPANSION = /\$\(|`/;
const BLANK = '"x"';

/** Index just after a `$(cat <<'EOF' ... EOF\n)` that starts at `at`, or -1 when it is anything else. */
function skipCatHeredoc(text, at) {
  CAT_HEREDOC.lastIndex = at;
  const open = CAT_HEREDOC.exec(text);
  if (open === null) return -1;
  const delimiter = open[2] ?? open[3] ?? open[4] ?? open[5];
  const bodyStart = CAT_HEREDOC.lastIndex;
  for (let lineStart = bodyStart; lineStart <= text.length; ) {
    const newline = text.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    if ((open[1] ? line.replace(/^\t+/, '') : line) === delimiter) {
      if (open[5] !== undefined && EXPANSION.test(text.slice(bodyStart, lineStart))) return -1;
      HEREDOC_CLOSE.lastIndex = lineEnd;
      return HEREDOC_CLOSE.test(text) ? HEREDOC_CLOSE.lastIndex : -1;
    }
    if (newline === -1) return -1;
    lineStart = newline + 1;
  }
  return -1;
}

/** Index just after the double-quoted string that opens at `start`, or -1 when it holds an expansion that could run or never closes. */
function endOfDoubleQuoted(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const char = text[i];
    if (char === '\\') i += 2;
    else if (char === '"') return i + 1;
    else if (char === '`') return -1;
    else if (char === '$' && text[i + 1] === '(') {
      i = skipCatHeredoc(text, i);
      if (i === -1) return -1;
    } else i++;
  }
  return -1;
}

/** One shell word from `from`: where it ends, its text before a lone quoted part, and that quoted part (null when none or not alone). */
function readWord(text, from) {
  let i = from;
  let quoted = null;
  let parts = 0;
  while (i < text.length && !/\s/.test(text[i]) && !STATEMENT_END.includes(text[i]) && !REDIRECT.includes(text[i])) {
    const char = text[i];
    const end = char === "'" ? text.indexOf("'", i + 1) + 1 : char === '"' ? endOfDoubleQuoted(text, i) : 0;
    if (char === '\\') i += 2;
    else if (char !== "'" && char !== '"') i++;
    else if (end <= 0) return undefined;
    else {
      parts++;
      quoted ??= { start: i, end };
      i = end;
    }
  }
  const alone = parts === 1 && quoted.end === i;
  return { end: i, quoted: alone ? quoted : null, prefix: alone ? text.slice(from, quoted.start) : '' };
}

/** The ranges of safe message arguments in the command that starts at `from` (its arguments, up to the end of the statement). */
function messageRanges(text, from) {
  const ranges = [];
  let afterFlag = false;
  for (let i = from; i < text.length; ) {
    if (/[ \t]/.test(text[i]) || REDIRECT.includes(text[i])) {
      i++;
      continue;
    }
    if (STATEMENT_END.includes(text[i])) break;
    const word = readWord(text, i);
    if (word === undefined) break;
    if (word.quoted !== null && ((afterFlag && word.prefix === '') || MESSAGE_FLAG_ATTACHED.test(word.prefix))) ranges.push(word.quoted);
    afterFlag = word.quoted === null && MESSAGE_FLAG.test(text.slice(i, word.end));
    i = word.end;
  }
  return ranges;
}

/** @param {string} text command text (line continuations already joined) @returns {string} text with safe message arguments blanked */
export function withoutMessageText(text) {
  let out = '';
  let copied = 0;
  for (const command of text.matchAll(MESSAGE_COMMAND)) {
    const from = command.index + command[0].length;
    if (from < copied) continue;
    for (const { start, end } of messageRanges(text, from)) {
      out += text.slice(copied, start) + BLANK;
      copied = end;
    }
  }
  return out + text.slice(copied);
}

// The code files a Bash command may write: the candidates hooks/bash-writes.mjs records before the command and compares after it
// (`sed -i`, `perl -i`, `tee`, `> file`, `cp`/`mv` targets, `git checkout`/`git restore` paths, python/node/ruby/perl inline or heredoc
// scripts). Exports: bashCodeWrites(command, cwd) -> string[] of absolute paths. A pure parser: no I/O, it logs nothing.
// Naming a path the command only reads costs bash-writes.mjs one hash and logs nothing (only a changed file is logged); a write it
// cannot name (a script run, `git apply`, `git checkout <branch>`, a variable path) is missed, the safe direction.
// Interpreter scripts are not parsed: every code-looking path word in the command text (heredoc body included) counts.
import { isAbsolute, resolve } from 'node:path';
import { CODE_FILE } from './diagnostics.mjs';
import { commandOf } from './command-of.mjs';
import { flagsOf, tokenize } from './shell-words.mjs';

const INTERPRETERS = /^(python\d*(\.\d+)?|node|nodejs|deno|bun|ruby|perl|php)$/;
const CODE_WORD = /[\w@+=.\/~-]+\.(?:ts|tsx|js|jsx|mjs|cjs)\b/g;
const IN_PLACE = /^-[a-zA-Z]*i|^--in-place/;
const OUTPUT_REDIRECT = /^(?:\d*>>?|&>>?|\d*>\|)(.*)$/;
const UNKNOWN_DIR = /^-|[~$`*?[\]{}]/;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);
const FILE_WRITERS = new Set(['tee', 'cp', 'mv', 'install', 'truncate', 'dd']);
const GIT_PATH_WRITERS = new Set(['checkout', 'restore']); // `git checkout -- <path>`, `git restore <path>`: the paths named after them

const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-p', '-pe', '-E', '--eval', '--print', '-']);
const stripKey = (word) => word.replace(/^of=/, ''); // dd of=file

function redirectedFiles(tokens) {
  const out = [];
  tokens.forEach((t, i) => {
    const m = OUTPUT_REDIRECT.exec(t);
    if (m) out.push(m[1] || tokens[i + 1] || '');
  });
  return out;
}

/** Files one parsed command writes, judged by its kind; interpreter commands are handled on the raw text instead. */
function writtenBy({ cmd, args }, tokens) {
  const inPlace = (cmd === 'sed' || cmd === 'perl') && flagsOf(args).some((f) => IN_PLACE.test(f));
  const positional = args.filter((a) => !a.startsWith('-'));
  const gitPaths = cmd === 'git' && GIT_PATH_WRITERS.has(args[0]);
  const written = inPlace || cmd === 'tee' ? positional : gitPaths ? positional.slice(1) : FILE_WRITERS.has(cmd) ? positional.slice(-1) : [];
  return [...written, ...redirectedFiles(tokens)].map(stripKey);
}

/**
 * @param {string} command raw command text
 * @param {string} cwd directory the command starts in; relative paths resolve against it
 * @returns {string[]} distinct absolute paths of code files the command may write
 */
export function bashCodeWrites(command, cwd) {
  const { segs } = tokenize(command);
  const hasHeredoc = command.includes('<<');
  const files = new Set();
  let dir = cwd;
  const add = (words) => {
    for (const w of words) if (w && CODE_FILE.test(w) && !w.includes('$')) files.add(isAbsolute(w) ? w : resolve(dir, w));
  };
  for (const seg of segs) {
    const parsed = commandOf(seg);
    if (parsed.cmd === 'cd' && parsed.args.length === 1 && !UNKNOWN_DIR.test(parsed.args[0])) dir = resolve(dir, parsed.args[0]);
    if (SHELLS.has(parsed.cmd) && /^-[a-zA-Z]*c$/.test(parsed.args[0] ?? '') && parsed.args[1]) add(bashCodeWrites(parsed.args[1], dir));
    add(writtenBy(parsed, seg));
    const inline = hasHeredoc || parsed.args.some((a) => INLINE_CODE_FLAGS.has(a));
    // running a script file (`node build.mjs`) writes nothing we can name; inline code and heredocs may write anything
    if (parsed.cmd !== undefined && INTERPRETERS.test(parsed.cmd) && inline) add(command.match(CODE_WORD) ?? []);
  }
  return [...files];
}

// Finds the environment variable names a source file reads (JS, TS, Vue, Svelte and friends).
// Exports: scanCode(text, wrappers) -> { reads: [{ name, line, builtin }], dynamic }; CODE_FILE_PATTERN.
// Invariants: pure; only names matched by the patterns below are captured, never a default value or anything else on the
//   line. `dynamic` counts accesses whose name is not a plain string literal (they give no name).
const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const LITERAL = `(['"\`])(${NAME})\\1`;
const VITE_BUILTINS = new Set(['MODE', 'DEV', 'PROD', 'SSR', 'BASE_URL']);

export const CODE_FILE_PATTERN = /\.(?:js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte)$/;

const escapeForRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Patterns whose last capture group is the variable name; `builtinAware` ones may name a Vite built-in. */
function readPatterns(wrappers) {
  const dotted = (object, builtinAware) => ({ pattern: new RegExp(`\\b${object}\\.(${NAME})`, 'g'), nameGroup: 1, builtinAware });
  const bracketed = (object, builtinAware) => ({ pattern: new RegExp(`\\b${object}\\[\\s*${LITERAL}\\s*\\]`, 'g'), nameGroup: 2, builtinAware });
  const calls = (callee) => ({ pattern: new RegExp(`\\b${callee}\\s*\\(\\s*${LITERAL}`, 'g'), nameGroup: 2, builtinAware: false });
  return [
    dotted('process\\.env', false), bracketed('process\\.env', false),
    dotted('import\\.meta\\.env', true), bracketed('import\\.meta\\.env', true),
    calls('Deno\\.env\\.get'), ...wrappers.map((wrapper) => calls(escapeForRegex(wrapper))),
  ];
}

/** `process.env[` or `import.meta.env[` not followed by a plain string literal, and `Deno.env.get(` with a non-literal. */
const DYNAMIC_ACCESS = new RegExp(
  `\\b(?:process\\.env|import\\.meta\\.env)\\[(?!\\s*${LITERAL}\\s*\\])|\\bDeno\\.env\\.get\\((?!\\s*${LITERAL}\\s*\\))`, 'g');

/**
 * @param {string} text source file content
 * @param {string[]} wrappers names of functions whose first string argument is a variable name
 * @returns {{ reads: { name: string, line: number, builtin: boolean }[], dynamic: number }}
 */
export function scanCode(text, wrappers = []) {
  const patterns = readPatterns(wrappers);
  const reads = [];
  let dynamic = 0;
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    for (const { pattern, nameGroup, builtinAware } of patterns) {
      for (const match of line.matchAll(pattern)) {
        const name = match[nameGroup];
        reads.push({ name, line: index + 1, builtin: builtinAware && VITE_BUILTINS.has(name) });
      }
    }
    dynamic += [...line.matchAll(DYNAMIC_ACCESS)].length;
  });
  return { reads, dynamic };
}

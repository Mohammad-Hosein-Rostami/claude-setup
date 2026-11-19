// Runs the Bash guard's decide() as it would run on Windows, on any host: inside home/hooks every import of node:path gets path.win32,
// process.platform reads 'win32', and HOME, USERPROFILE and TMPDIR are Windows paths. Used by tests/pre-bash-guard-win32.test.mjs in a
// child process (the platform switch must not leak into the test runner).
// Usage: node tests/win32-decide.mjs '<JSON: {cwd, project, commands: string[]}>'; prints JSON {command: 'ask' | 'allow'}.
// A simulation, not Windows: fs, the real Git Bash and cmd are not involved. The commands are only passed to decide(); nothing is executed.
import { registerHooks } from 'node:module';

const WIN32_HOME = 'C:\\Users\\pejvak';
const GUARD_TREE = new URL('../home/hooks/', import.meta.url).href;
const WIN32_PATH = `data:text/javascript,${encodeURIComponent(
  "import path from 'node:path'; const w = path.win32; export default w; export const posix = path.posix; export const win32 = w;"
  + 'export const { resolve, relative, isAbsolute, join, parse, dirname, basename, extname, normalize, sep, delimiter, format } = w;',
)}`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromGuard = context.parentURL?.startsWith(GUARD_TREE) === true;
    return fromGuard && specifier === 'node:path' ? { url: WIN32_PATH, shortCircuit: true } : nextResolve(specifier, context);
  },
});
Object.defineProperty(process, 'platform', { value: 'win32' });
Object.assign(process.env, { HOME: WIN32_HOME, USERPROFILE: WIN32_HOME, TMPDIR: `${WIN32_HOME}\\AppData\\Local\\Temp` });

const { cwd, project, commands } = JSON.parse(process.argv[2]);
const { decide } = await import(new URL('pre-bash-guard.mjs', GUARD_TREE).href);
const answers = Object.fromEntries(commands.map((command) => [command, decide(command, { cwd, project }).ask === true ? 'ask' : 'allow']));
process.stdout.write(JSON.stringify(answers));

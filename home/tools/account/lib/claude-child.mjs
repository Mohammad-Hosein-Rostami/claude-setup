// Purpose: what every `claude` child of the setup shares: the environment it may get and how it is started on each platform.
// Used by the account tool's Haiku call (claude-call.mjs) and by the long-run runner (home/tools/long-run/lib/claude-run.mjs).
// Exports: BILLING_ENV, TOKEN_SHAPED, childEnv, claudeLaunch.
// Invariants: a child env never holds a variable that moves the call off the Claude subscription (BILLING_ENV), whatever the
// caller adds; on win32 the npm install is `claude.cmd`, which Node can start only through a shell, so every argument is quoted
// there and no free text (a prompt) may be passed as an argument: callers send it on stdin or through a file.

/** Variables that would move a call from the Claude subscription to API billing, Bedrock, Vertex or another endpoint. */
export const BILLING_ENV = /^(?:ANTHROPIC_.*|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|AWS_BEARER_TOKEN_BEDROCK)$/;

/** Any token-shaped text of a child's output, its own token or another one (security review 1, S2). Global: reset lastIndex is not needed with replace. */
export const TOKEN_SHAPED = /sk-ant-[A-Za-z0-9_-]+/g;

const quoteForCmd = (arg) => `"${arg.replace(/"/g, '\\"')}"`;

/**
 * The environment of a `claude` child: the caller's env with `added` on top, then every BILLING_ENV variable and every name
 * `dropped` matches removed (added ones included, so no caller can switch billing back on).
 * @param {object} env the parent environment.
 * @param {object} added variables to set (the login token, labels).
 * @param {RegExp | null} dropped further names to remove, or null.
 * @returns {object} a new object; `env` is not changed.
 */
export function childEnv(env, added = {}, dropped = null) {
  const result = { ...env, ...added };
  for (const name of Object.keys(result)) {
    if (BILLING_ENV.test(name) || (dropped !== null && dropped.test(name))) delete result[name];
  }
  return result;
}

/**
 * How to start `claude` with `args`: a plain `claude` without a shell elsewhere; on win32 `claude.cmd` through a shell with every
 * argument quoted (Node cannot spawn a .cmd directly).
 * @param {string} platform `process.platform`.
 * @param {string[]} args the arguments; none may hold free text on win32 (see the header).
 * @returns {{command: string, args: string[], shell: boolean}}
 */
export function claudeLaunch(platform, args) {
  if (platform !== 'win32') return { command: 'claude', args: [...args], shell: false };
  return { command: 'claude.cmd', args: args.map(quoteForCmd), shell: true };
}

// The shape a name must have to be printed without a second reason. A fragment of a secret (a base64 line, a token) rarely
// looks like an ALL_CAPS or all_lower variable name of at most 64 characters, so this is the second defence after the parsers.
// Exports: MAX_NAME_LENGTH, isPlainName(name).
export const MAX_NAME_LENGTH = 64;
const PLAIN_NAME = /^(?:[A-Z_][A-Z0-9_]{0,63}|[a-z_][a-z0-9_]{0,63})$/;

/** True for `UPPER_SNAKE` or `lower_snake` names of 1 to 64 characters. */
export const isPlainName = (name) => PLAIN_NAME.test(name);

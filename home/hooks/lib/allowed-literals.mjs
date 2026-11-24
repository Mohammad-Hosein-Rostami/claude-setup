// What is left of the per-session memory of literal secrets the owner allowed before owner decision R22-G1 (2026-11-23): since then a
// secret never asks, so nothing reads or writes that memory any more. Exports: allowedLiteralsDir(env) -> string, MIN_VALUE_LENGTH.
// allowedLiteralsDir stays because old sessions may still have files there (~/.claude/state/guard-allowed/<session>.json) and
// lib/guard-state-write.mjs keeps asking before a command changes them; MIN_VALUE_LENGTH is the shortest value lib/secrets.mjs counts
// as a secret. Pure, no I/O.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A value shorter than this is a test fixture (`token=t`), not a secret (lib/secrets.mjs). */
export const MIN_VALUE_LENGTH = 8;

/**
 * @param {Record<string, string | undefined>} env process environment (HOME or USERPROFILE)
 * @returns {string} the folder of the old per-session store (HOME or USERPROFILE from env, else the OS home)
 */
export const allowedLiteralsDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'guard-allowed');

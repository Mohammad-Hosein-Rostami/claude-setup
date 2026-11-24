// Marks an AskUserQuestion that the owner answered in the terminal, so the PermissionRequest hook can close its popups.
// Exports: questionTexts(toolInput) -> string[] | undefined, markQuestionAnswered(call, env, now), wasQuestionAnswered(call, sinceMs, env)
// -> boolean, questionAnsweredDir(env); call is {session, agentId, questions: string[]} from the hook input.
// Why: Claude Code shows its terminal question and runs the PermissionRequest hook at the same time and never tells the hook when the
// terminal wins. It does run PostToolUse (hook question-answered.mjs) once the tool has run, and that hook writes the mark read here.
// Store: ~/.claude/state/question-answered/<session>.json (HOME from env), {"marks": {"<sha256 of agent and question texts>": <ms>}},
// kept by lib/session-store.mjs (a per-user 0700 folder, 0600 files, links and special files refused) with lib/session-lock.mjs.
// Invariants: only digests are stored, never question text; a mark counts only when it is at least as new as the popup (`sinceMs`), so an
// earlier identical question never closes a newer popup; marks older than MARK_TTL_MS are dropped on the next write; nothing throws.
// Trust: any process of the same user can write a mark and so close the popups; the only effect is that the question stays with Claude Code's
// own terminal UI (the popup loop ends with undefined and prints nothing), so a forged mark fails safe.
// Limit: the key has no tool_use_id (the PermissionRequest input has none), so two identical question sets asked at the same moment in one
// session and agent cannot be told apart.
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withSessionLock } from './session-lock.mjs';
import { isSessionId, readSessionFile, writeSessionFile } from './session-store.mjs';

const MARK_TTL_MS = 15 * 60 * 1000; // a popup lives at most 4 x 190 s; a mark older than 15 min belongs to an earlier question
const MAX_STORE_BYTES = 64 * 1024; // a few hundred live marks at most; a bigger file was not written here

/** @returns {string} the directory holding one file per session */
export const questionAnsweredDir = (env = process.env) => join(env.HOME || env.USERPROFILE || homedir(), '.claude', 'state', 'question-answered');

/**
 * @param {{questions?: unknown}} toolInput the AskUserQuestion tool input (PermissionRequest and PostToolUse carry the same questions)
 * @returns {string[] | undefined} the question texts, or undefined when the input has no non-empty list of questions with text
 */
export function questionTexts(toolInput) {
  const questions = toolInput?.questions;
  if (!Array.isArray(questions) || questions.length === 0 || !questions.every((item) => typeof item?.question === 'string')) return undefined;
  return questions.map((item) => item.question);
}

/** @returns {string} the mark key: sha256 of the agent and the question texts (the session is the file) */
const digestOf = ({ agentId, questions }) => createHash('sha256').update(JSON.stringify([String(agentId ?? ''), questions])).digest('hex');

/** @returns {boolean} true when the call has a usable session id and question list */
const usable = (call) => isSessionId(call?.session) && Array.isArray(call.questions);

/** @returns {Record<string, number> | undefined} the stored marks; undefined when the store is unusable */
function readMarks(dir, session) {
  const text = readSessionFile(dir, session, MAX_STORE_BYTES);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text ?? '{}').marks ?? {};
  } catch {
    return {}; // a damaged file: nothing is marked, and the next write replaces it
  }
}

/**
 * Records that the owner answered these questions in the terminal. Never throws.
 * @param {{session?: string, agentId?: string, questions: string[]}} call the answered question set
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @param {() => number} now clock in milliseconds
 * @returns {void}
 */
export function markQuestionAnswered(call, env = process.env, now = Date.now) {
  if (!usable(call)) return;
  const dir = questionAnsweredDir(env);
  withSessionLock(dir, call.session, () => {
    const marks = readMarks(dir, call.session);
    if (!marks) return;
    const fresh = Object.entries(marks).filter(([, at]) => typeof at === 'number' && now() - at <= MARK_TTL_MS);
    writeSessionFile(dir, call.session, JSON.stringify({ marks: { ...Object.fromEntries(fresh), [digestOf(call)]: now() } }));
  });
}

/**
 * @param {{session?: string, agentId?: string, questions: string[]}} call the question set a popup is open for
 * @param {number} sinceMs when the popup opened (clock in milliseconds); an older mark belongs to an earlier question
 * @param {Record<string, string | undefined>} env process environment (HOME)
 * @returns {boolean} true when the owner answered this question set in the terminal after `sinceMs`
 */
export function wasQuestionAnswered(call, sinceMs, env = process.env) {
  if (!usable(call)) return false;
  const markedAt = readMarks(questionAnsweredDir(env), call.session)?.[digestOf(call)];
  return typeof markedAt === 'number' && markedAt >= sinceMs;
}

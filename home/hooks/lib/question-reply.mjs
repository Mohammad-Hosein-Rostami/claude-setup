// AskUserQuestion for the PermissionRequest hook (permission-timed-allow.mjs): one timed popup per question, one after the other.
// Exports: questionReply(input, env, {ask, pollMs}) -> Promise<{behavior: 'allow', updatedInput} | undefined>; questionTimeoutSeconds(env);
// TERMINAL_AUTO_CONTINUE_S.
// Each question gets its own popup (title "question 2 of 3", that question and the option that will be taken) and its own wait,
// CLAUDE_QUESTION_TIMEOUT_S (default 120 s, questionTimeoutSeconds; cut so that all popups end before the terminal question
// auto-continues at 600 s, askUserQuestionTimeout "10m"). The body is display design 7.5: the question, all options with the recommended
// one first, and what happens with no answer; no tool, directory or session line. While the question is open the asking marker
// (lib/asking-marker.mjs, with the first question's `header` label) is written; question-answered.mjs clears it on PostToolUse or PostToolUseFailure, and it ages out. "Use recommended" or no answer in the wait takes that question's
// "(Recommended)" option, else its first; a multiSelect question gets that single option. Only a timeout adds `annotations` {question text:
// {notes}} saying the answer was taken by default, not chosen by the owner (UNCONFIRMED), for that question alone. After the last question
// the result is an allow with updatedInput = the input plus `answers` {question text: option label} (hooks docs, AskUserQuestion input and
// PermissionRequest decision control).
// Popup 1 has "Use recommended" as its default (Enter) button; popups 2..N have "Answer in terminal" (a stray Enter typed into the terminal question must not answer).
// "Answer in terminal" (Esc on macOS), a failed dialog or no GUI on any question stop the loop: undefined, so Claude Code's own question UI
// (which already shows every question) takes over; answers already collected are dropped, never an invented answer.
// Terminal answer: Claude Code shows its own question and runs this hook side by side and never says when the owner answers there. The
// PostToolUse hook question-answered.mjs leaves a mark (lib/question-answered.mjs); it is polled every pollMs while a popup is open and
// checked before each next one. Turning the question down in the terminal ("Chat about this", Esc) runs no tool and leaves no mark, so the
// session transcript is watched for it too (lib/question-rejected.mjs). A mark or a rejection closes the open popup (abort signal, lib/timed-ask-async.mjs) and the loop ends with undefined.
// Invariants: never two popups at once; every popup is logged (guard log) without secrets; no exception leaves this function for a bad input.
import { logDecision } from './guard-log.mjs';
import { wasQuestionAnswered } from './question-answered.mjs';
import { watchTerminalRejection } from './question-rejected.mjs';
import { answerAskAsync } from './timed-ask-async.mjs';
import { markAsking } from './asking-marker.mjs';
import { MAX_ASK_TIMEOUT_S, formatDuration } from './timed-ask.mjs';

const HOOK_NAME = 'permission-timed-allow';
const QUESTION_TOOL = 'AskUserQuestion';
const QUESTION_BUTTONS = { accept: 'Use recommended', decline: 'Answer in terminal' };
// Popups 2..N open minutes after the terminal question appeared, often while the owner types in it: a stray Enter must not pick an answer,
// so there Enter hits "Answer in terminal" (the safe hand-back). "Use recommended" and the timeout answer stay as they are.
const LATER_QUESTION_BUTTONS = { ...QUESTION_BUTTONS, defaultButton: 'decline' };
const QUESTION_TITLE = 'Claude asks';
// Each question popup's own wait (owner RC3, 2026-11-22: 2 min; was 60 s), apart from the permission wait (CLAUDE_PERMISSION_TIMEOUT_S, 120 s).
const QUESTION_TIMEOUT_ENV = 'CLAUDE_QUESTION_TIMEOUT_S';
const DEFAULT_QUESTION_TIMEOUT_S = 120;

/** @returns {number} CLAUDE_QUESTION_TIMEOUT_S when it is a whole positive number (at most MAX_ASK_TIMEOUT_S), else 120 */
export function questionTimeoutSeconds(env = process.env) {
  const seconds = Number(env[QUESTION_TIMEOUT_ENV]);
  return Number.isInteger(seconds) && seconds > 0 ? Math.min(seconds, MAX_ASK_TIMEOUT_S) : DEFAULT_QUESTION_TIMEOUT_S;
}
const RECOMMENDED = /\(Recommended\)\s*$/i; // how Claude marks the option it would pick
// The terminal question runs beside this hook and auto-continues (settings askUserQuestionTimeout "10m") with the answers chosen so far, which
// would end the hook's remaining popups. So all popups together must end before it: the wait of each is cut to fit, with a margin for starting them.
// 120 s each fits up to 4 questions: min(120, floor((600 - 30) / N)), so 5 questions get 114 s and 6 get 95 s.
export const TERMINAL_AUTO_CONTINUE_S = 600;
const POPUP_MARGIN_S = 30;
const TERMINAL_POLL_MS = 250; // how often the open popup looks for the terminal answer mark: a closing popup is seen within this

/** @returns {boolean} true for a non-empty list of questions, each with question text and options that all have a label */
const isQuestionList = (questions) => Array.isArray(questions) && questions.length > 0 && questions.every((item) =>
  typeof item?.question === 'string' && Array.isArray(item.options) && item.options.length > 0
  && item.options.every((option) => typeof option?.label === 'string'));

/** @returns {string} the label of the option marked "(Recommended)", else of the first option */
const recommendedLabel = (options) => (options.find((option) => RECOMMENDED.test(option.label)) ?? options[0]).label;

const plainLabel = (label) => label.replace(RECOMMENDED, '').trim();

/** `Options: 1 keep it (recommended) · 2 remove now`, the recommended option first. */
function optionsLine(options, answer) {
  const ordered = [...options].sort((a, b) => (b.label === answer) - (a.label === answer));
  return `Options: ${ordered.map((option, k) => `${k + 1} ${plainLabel(option.label)}${option.label === answer ? ' (recommended)' : ''}`).join(' · ')}`;
}

/** @returns {object} the popup request for question `index` (0-based) of `count`: display design 7.5's body, the option taken with no answer */
function popupRequest({ item, index, count, answer, timeoutS, input }) {
  return {
    tool: QUESTION_TOOL,
    reason: `Claude asks question ${index + 1} of ${count}; with no answer it takes the option shown`,
    title: count > 1 ? `${QUESTION_TITLE} (${index + 1} of ${count})` : QUESTION_TITLE,
    buttons: index === 0 ? QUESTION_BUTTONS : LATER_QUESTION_BUTTONS,
    body: [
      item.header ? `[${item.header}] ${item.question}` : item.question,
      optionsLine(item.options, answer),
      `No answer in ${formatDuration(timeoutS)} → "${plainLabel(answer)}" is taken and asked again in the next report.`,
    ],
    timeoutS,
    cwd: typeof input.cwd === 'string' ? input.cwd : process.cwd(),
    sessionId: input.session_id,
    agentId: input.agent_id,
  };
}

/**
 * Marks answers as taken by default. Claude Code puts each note in the tool result ("Q"="A" notes: ...) and then tells Claude to read the
 * answers carefully instead of "Your questions have been answered" (read from the CLI 2.1.325 code).
 * @returns {object} the input's annotations with a timeout note on each question in `timedOut`, other annotation fields kept
 */
function timeoutAnnotations(toolInput, timedOut, timeoutS) {
  const notes = `No answer in ${formatDuration(timeoutS)}: this option was taken by default, not chosen by the owner (UNCONFIRMED)`;
  const existing = toolInput.annotations && typeof toolInput.annotations === 'object' ? toolInput.annotations : {};
  return { ...existing, ...Object.fromEntries(timedOut.map((question) => [question, { ...existing[question], notes }])) };
}

/**
 * Answers an AskUserQuestion prompt question by question, unless the owner chooses to answer in the terminal.
 * @param {{tool_input?: {questions?: unknown[]}, cwd?: string, session_id?: string, agent_id?: string}} input hook JSON for an AskUserQuestion PermissionRequest
 * @param {Record<string, string | undefined>} env process environment (timeout, GUI detection, HOME, log path)
 * @param {{ask?: typeof answerAskAsync, pollMs?: number}} options `ask` is the popup (a test passes a fake); `pollMs` how often to look for the terminal answer
 * @returns {Promise<{behavior: 'allow', updatedInput: object} | undefined>} the allow decision carrying the answers, or undefined to leave the question to Claude Code's own UI
 */
export async function questionReply(input, env, { ask = answerAskAsync, pollMs = TERMINAL_POLL_MS } = {}) {
  const toolInput = input.tool_input;
  if (!isQuestionList(toolInput?.questions)) return undefined;
  const questions = toolInput.questions;
  const timeoutS = Math.min(questionTimeoutSeconds(env), Math.floor((TERMINAL_AUTO_CONTINUE_S - POPUP_MARGIN_S) / questions.length));
  markAsking({ session: input.session_id, kind: 'question', tool: QUESTION_TOOL, count: questions.length, openedAt: Date.now(), waitS: timeoutS, header: questions[0].header }, env);
  const terminalMark = { session: input.session_id, agentId: input.agent_id, questions: questions.map((item) => item.question) };
  const openedAt = Date.now();
  const turnedDownInTerminal = watchTerminalRejection(input.transcript_path);
  const answeredInTerminal = () => wasQuestionAnswered(terminalMark, openedAt, env) || turnedDownInTerminal();
  const closePopup = new AbortController();
  const watch = setInterval(() => { if (answeredInTerminal()) closePopup.abort(); }, pollMs);
  const answers = {};
  const timedOut = [];
  try {
    for (const [index, item] of questions.entries()) {
      if (answeredInTerminal()) return undefined;
      const answer = recommendedLabel(item.options);
      const request = popupRequest({ item, index, count: questions.length, answer, timeoutS, input });
      const result = await ask(request, env, { signal: closePopup.signal });
      const decision = result.decision === 'allow' ? 'allow' : 'ask'; // "ask": Claude Code's own question UI
      logDecision({ hook: HOOK_NAME, tool: QUESTION_TOOL, command: item.question, cwd: request.cwd, session: input.session_id, decision, outcome: result.outcome, reason: request.reason }, env);
      if (decision !== 'allow') return undefined;
      answers[item.question] = answer;
      if (result.outcome === 'timeout') timedOut.push(item.question);
    }
  } finally {
    clearInterval(watch);
  }
  const annotations = timedOut.length > 0 ? { annotations: timeoutAnnotations(toolInput, timedOut, timeoutS) } : {};
  return { behavior: 'allow', updatedInput: { ...toolInput, answers, ...annotations } };
}

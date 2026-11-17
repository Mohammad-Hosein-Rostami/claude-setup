// AskUserQuestion for the PermissionRequest hook (permission-timed-allow.mjs): one timed popup per question, one after the other.
// Exports: questionReply(input, env, {ask, pollMs}) -> Promise<{behavior: 'allow', updatedInput} | undefined>.
// Each question gets its own popup (title "question 2 of 3", that question and the option that will be taken) and its own wait,
// CLAUDE_PERMISSION_TIMEOUT_S (default 2 min, see lib/timed-ask.mjs; cut so that all popups end before the terminal question auto-continues). "Use recommended" or no answer in the wait takes that question's
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
import { formatDuration, permissionTimeoutSeconds } from './timed-ask.mjs';

const HOOK_NAME = 'permission-timed-allow';
const QUESTION_TOOL = 'AskUserQuestion';
const QUESTION_BUTTONS = { accept: 'Use recommended', decline: 'Answer in terminal' };
// Popups 2..N open minutes after the terminal question appeared, often while the owner types in it: a stray Enter must not pick an answer,
// so there Enter hits "Answer in terminal" (the safe hand-back). "Use recommended" and the timeout answer stay as they are.
const LATER_QUESTION_BUTTONS = { ...QUESTION_BUTTONS, defaultButton: 'decline' };
const QUESTION_TITLE = 'Claude Code: question';
const RECOMMENDED = /\(Recommended\)\s*$/i; // how Claude marks the option it would pick
// The terminal question runs beside this hook and auto-continues (settings askUserQuestionTimeout "10m") with the answers chosen so far, which
// would end the hook's remaining popups. So all popups together must end before it: the wait of each is cut to fit, with a margin for starting them.
export const TERMINAL_AUTO_CONTINUE_S = 600;
const POPUP_MARGIN_S = 30;
const TERMINAL_POLL_MS = 250; // how often the open popup looks for the terminal answer mark: a closing popup is seen within this

/** @returns {boolean} true for a non-empty list of questions, each with question text and options that all have a label */
const isQuestionList = (questions) => Array.isArray(questions) && questions.length > 0 && questions.every((item) =>
  typeof item?.question === 'string' && Array.isArray(item.options) && item.options.length > 0
  && item.options.every((option) => typeof option?.label === 'string'));

/** @returns {string} the label of the option marked "(Recommended)", else of the first option */
const recommendedLabel = (options) => (options.find((option) => RECOMMENDED.test(option.label)) ?? options[0]).label;

/** @returns {object} the popup request for question `index` (0-based) of `count`: that question and the option that will be taken */
function popupRequest({ item, index, count, answer, timeoutS, input }) {
  return {
    tool: QUESTION_TOOL,
    reason: `Claude asks question ${index + 1} of ${count}; with no answer it takes the option shown`,
    title: count > 1 ? `${QUESTION_TITLE} ${index + 1} of ${count}` : QUESTION_TITLE,
    buttons: index === 0 ? QUESTION_BUTTONS : LATER_QUESTION_BUTTONS,
    details: [
      { label: 'Question', value: item.header ? `[${item.header}] ${item.question}` : item.question },
      { label: 'Answer', value: answer, keepStart: true },
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
  const timeoutS = Math.min(permissionTimeoutSeconds(env), Math.floor((TERMINAL_AUTO_CONTINUE_S - POPUP_MARGIN_S) / questions.length));
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

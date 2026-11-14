// Purpose: opt-in interaction steps (fill, click, hover, focus ...) that run after the page is ready and before
// the freeze style and the capture, so a state (hover, error, filled form) can be measured.
// Exports: validateSteps, loadSteps, runSteps. Invariants: the steps file is validated against a fixed
// action table (no code or string is ever evaluated); an unknown action, bad field type, or a selector that does not
// match exactly one element, a Playwright failure (timeout, bad key ...) or an unknown field is a UsageError (exit 2)
// naming the step number and action. Steps never change tolerances or gates.
import fs from 'node:fs';
import { clickFacts, describeBlockedClick } from './click-cover.mjs';
import { UsageError } from './errors.mjs';

const STEP_TIMEOUT_MS = 5000;
const MAX_WAIT_MS = 30000; // a typo like 1e9 must not hang the run
/** action -> required fields (name -> type) besides "action". */
const ACTION_FIELDS = {
  fill: { selector: 'string', value: 'string' }, select: { selector: 'string', value: 'string' }, press: { selector: 'string', key: 'string' },
  click: { selector: 'string' }, check: { selector: 'string' }, uncheck: { selector: 'string' }, focus: { selector: 'string' },
  hover: { selector: 'string' }, waitFor: { selector: 'string' }, blur: {}, wait: { ms: 'number' },
};
/** Element actions whose Playwright locator method has the same name and takes only options. */
const PLAIN_LOCATOR_ACTIONS = new Set(['click', 'check', 'uncheck', 'focus', 'hover']);
/** Actions that need the pointer to reach the element; a timeout on one of them gets the "what covers it" explanation. */
const POINTER_ACTIONS = new Set(['click', 'check', 'uncheck', 'hover']);

function validateStep(step, i) {
  const label = `step ${i + 1}`;
  if (step === null || typeof step !== 'object' || Array.isArray(step)) throw new UsageError(`${label}: must be an object`);
  if (typeof step.action !== 'string' || !Object.hasOwn(ACTION_FIELDS, step.action)) throw new UsageError(`${label}: unknown action ${JSON.stringify(step.action)}`);
  const unknown = Object.keys(step).filter((k) => k !== 'action' && !Object.hasOwn(ACTION_FIELDS[step.action], k));
  if (unknown.length > 0) throw new UsageError(`${label} (${step.action}): unknown field(s) ${unknown.map((k) => `"${k}"`).join(', ')}`);
  for (const [field, type] of Object.entries(ACTION_FIELDS[step.action])) {
    if (step[field] === undefined) throw new UsageError(`${label} (${step.action}): missing field "${field}"`);
    if (typeof step[field] !== type) throw new UsageError(`${label} (${step.action}): "${field}" must be a ${type}`);
  }
  if (step.action === 'wait' && !(Number.isFinite(step.ms) && step.ms >= 0 && step.ms <= MAX_WAIT_MS)) throw new UsageError(`${label} (wait): "ms" must be a number from 0 to ${MAX_WAIT_MS}`);
}

/**
 * Validate the shape of a steps list (no browser needed).
 * @param {unknown} steps parsed JSON
 * @returns {object[]} the same list
 * @throws {UsageError} naming the first bad step (1-based)
 */
export function validateSteps(steps) {
  if (!Array.isArray(steps)) throw new UsageError('steps must be a JSON array');
  steps.forEach(validateStep);
  return steps;
}

/**
 * Read and validate a steps JSON file.
 * @param {string} file path given to --steps
 * @returns {object[]} validated steps
 * @throws {UsageError} on an unreadable file, invalid JSON or bad steps
 */
export function loadSteps(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new UsageError(`--steps ${file}: ${error.message}`);
  }
  return validateSteps(parsed);
}

async function targetOf(page, step, i) {
  const count = await page.locator(step.selector).count();
  if (count !== 1) throw new UsageError(`step ${i + 1} (${step.action}): selector ${JSON.stringify(step.selector)} matched ${count} elements, expected exactly 1`);
  return page.locator(step.selector);
}

async function waitForTarget(page, step, i) {
  try {
    await page.locator(step.selector).waitFor({ timeout: STEP_TIMEOUT_MS });
  } catch (error) {
    throw new UsageError(`step ${i + 1} (waitFor): ${error.message.split('\n')[0]}`);
  }
  await targetOf(page, step, i);
}

async function runElementStep(page, step, i) {
  const el = await targetOf(page, step, i);
  try {
    await dispatchStep(el, step);
  } catch (error) {
    const why = error.name === 'TimeoutError' && POINTER_ACTIONS.has(step.action) ? await explainBlocked(el) : '';
    throw new UsageError(`step ${i + 1} (${step.action}): ${error.message.split('\n')[0]}${why}`);
  }
}

/** " - <what covers the target>" for a timed-out pointer action; when the page cannot be asked, says so (the Playwright message is reported either way). */
async function explainBlocked(el) {
  try {
    return ` - ${describeBlockedClick(await el.evaluate(clickFacts))}`;
  } catch (error) {
    return ` - (could not inspect what covers it: ${error.message.split('\n')[0]})`;
  }
}

async function dispatchStep(el, step) {
  const opt = { timeout: STEP_TIMEOUT_MS };
  if (step.action === 'select') await el.selectOption(step.value, opt);
  else if (step.action === 'press') await el.press(step.key, opt);
  else if (step.action === 'fill') await el.fill(step.value, opt);
  else if (PLAIN_LOCATOR_ACTIONS.has(step.action)) await el[step.action](opt);
  if (step.action === 'focus' && !(await el.evaluate((node) => document.activeElement === node))) {
    throw new Error('the element did not take focus (it is not focusable: use a button, link or input, or add tabindex)');
  }
}

/**
 * Run validated steps in order on a page.
 * @param {object} page Playwright page
 * @param {object[]} steps output of validateSteps
 * @throws {UsageError} when a selector count is not exactly 1, a wait times out, or Playwright fails the action (message names the step)
 */
export async function runSteps(page, steps) {
  for (const [i, step] of steps.entries()) {
    if (step.action === 'wait') await page.waitForTimeout(step.ms);
    else if (step.action === 'blur') await page.evaluate(() => document.activeElement?.blur());
    else if (step.action === 'waitFor') await waitForTarget(page, step, i);
    else await runElementStep(page, step, i);
  }
}

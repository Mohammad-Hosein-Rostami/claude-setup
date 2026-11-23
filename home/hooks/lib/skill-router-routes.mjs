// The skill router's routes (hooks/skill-router.mjs): which skills the owner's words in a prompt name, and which reminders the lines of
// an edit call for. Split out of that hook to keep it under 300 lines (C4).
// Exports: FIGMA_SKILLS, FOLLOW_UP_SKILLS, EDIT_GROUPS, promptRoutes(words, pasted), editGroups(file, toolInput, uiFile).
// Invariants: pure (no I/O). The request evidence is ui-proof's (ui-evidence.mjs): design words, UI nouns and the talk and negation
// rules are one definition for the router and the check plan, so a clause that talks about the checks ("the ui check chain is too
// heavy") or refuses ("don't touch the pixel perfect part") routes no UI skill, and a Figma link routes pixel anywhere, pasted too.
// An edit is classed by ui-evidence's classifyFile from at most EDIT_MAX_BYTES of its old and of its new text (P1: 256 KiB in all);
// a cut edit also gets the classes its path alone gives (app source: look and logic, since its unread rest could be either).
import { classifyFile, FIGMA_LINK, ownClauseMatches, uiClauses, UI_WORDS } from '../../tools/ui-proof/lib/ui-evidence.mjs';

export const FIGMA_SKILLS = ['figma-pixel-perfect', 'responsive-ui'];
export const FOLLOW_UP_SKILLS = ['accessibility-build', 'responsive-ui', 'ui-quality-pass'];
const UI_SKILLS = ['accessibility-build', 'responsive-ui', 'ui-quality-pass'];
// In first-match order after the design route (DESIGN_WORDS, FIGMA_LINK). Each regex runs in linear time (ownClauseMatches runs it per clause).
const SKILL_ROUTES = [
  { test: /responsive|mobile[\s-]?(first|layout|view|screen|width|breakpoint)|tablet[\s-]?(layout|view|width|screen|breakpoint|size)|on (a )?tablets?\b|breakpoint|overflow-[xy]|(text|horizontal|content|scroll) overflow|overflow (hidden|scroll|auto)|viewport|reflow|ریسپانسیو|موبایل/i, skills: ['responsive-ui'] },
  { test: /\bforms?\b(?!\s*data)|\bform[\s-]?validation|\bvalidat\w* (the )?(form|field)s?\b|فرم/i, skills: ['forms-validation'] },
  { test: /\b(loading|empty|error) states?\b|\bskeleton|\bpagination/i, skills: ['async-ui-states'] },
  // Bare "validation", "tablet" and "overflow" fired on backend prompts ("validate the JSON payload", "stack overflow").
  // Bare "keyboard", "focus" and "aria" (in "variable") fired on non-UI prompts, so they need UI context words.
  {
    test: /a11y|accessib|keyboard[\s-]?(nav\w*|access\w*|trap|support|only)|focus[\s-]?(ring|trap|order|state|visible|management)|\baria\b|aria-|contrast|screen reader/i,
    skills: ['accessibility-build'],
  },
  {
    // Coverage-matrix words. Bare "locale" fires on backend prompts, so it needs a UI-ish partner.
    test: /\brtl\b|\bltr\b|right[\s-]to[\s-]left|\bi18n\b|\bl10n\b|\blocali[sz](?:e[sd]?|ing|ations?)\b|\b(every|all|each|supported|per)[\s-]locales?\b|\blocale (switch|picker|selector)\b|\b(email|mail) templates?\b|\b(all|every) (the )?(screens|forms|pages)\b|\bevery (screen|form|page)\b|راست[\s‌-]*به[\s‌-]*چپ|راست‌چین|چندزبانه|قالب ایمیل/i,
    skills: ['ui-coverage'],
  },
  // Bare "page", "step", "style", "card", "theme", "layout" fire on non-UI prompts: the UI nouns of ui-evidence (UI_WORDS) are needed.
  { test: UI_WORDS, skills: UI_SKILLS },
];
// Too vague alone (hence "header" only in UI phrases, never HTTP; no "table", "tab", "menu", "grid"); they count only
// in a session already marked as UI work.
const WEAK_UI =
  /\b(styles?|styled|layout|align\w*|margin|padding|colou?rs?|fonts?|icons?|sidebar|footer|hero|banner|tooltip|cards?|theme|dark mode|hover|animation|(page|site|nav|section) header|header (bar|section|area|nav)|pages?)\b|رنگ|فونت|هدر|منو|دکمه|آیکون|چیدمان|فاصله/i;
// "continue" / "finish it" after a UI prompt: the same UI job goes on, so it gets the follow-up line (only in a UI session).
const JOB_FOLLOW_UP = /\b(continue|carry on|keep going|go on|resume|proceed|finish)\b|ادامه|تمامش|تمومش|تمام کن|تموم کن/i;
const OWN_PATTERNS = [...SKILL_ROUTES.map((route) => route.test), WEAK_UI, JOB_FOLLOW_UP];

/**
 * The routes of a prompt's own words.
 * @param {string} words the owner's words (lib/owner-words.mjs ownerWords: pasted blocks, harness blocks and summaries cut)
 * @param {string} pasted the text of the prompt's pasted blocks (pastedText), read for a Figma link only
 * @returns {{ design: boolean, skills: string[], weak: boolean, followUp: boolean }} design: design evidence (today's pixel text);
 *   skills: the skills named, without duplicates, design ones first; weak / followUp: a weak UI word or a "continue" outside talk and negation
 */
export function promptRoutes(words, pasted) {
  const design = uiClauses(words).design || FIGMA_LINK.test(pasted);
  const hits = ownClauseMatches(words, OWN_PATTERNS);
  const named = SKILL_ROUTES.filter((_, index) => hits[index]).flatMap((route) => route.skills);
  const skills = [...new Set([...(design ? FIGMA_SKILLS : []), ...named])];
  return { design, skills, weak: hits[SKILL_ROUTES.length], followUp: hits[SKILL_ROUTES.length + 1] };
}

/** The reminder groups of an edit, in this order; the text of each is skill-router-text.mjs EDIT_TEXTS. */
export const EDIT_GROUPS = ['look', 'logic', 'text'];
const GROUP_OF_CLASS = { look: 'look', globalLook: 'look', logic: 'logic', text: 'text' }; // test, docs, devConfig, deps: none
const PATH_CLASSES = new Set(['text', 'globalLook']); // the only classes a file that is not UI source gets a reminder for
const EDIT_MAX_BYTES = 128 * 1024; // of the old and of the new text each

/** The first EDIT_MAX_BYTES of `text` as lines, and whether text was cut. */
function cappedLines(text) {
  const head = Buffer.from(text.slice(0, EDIT_MAX_BYTES));
  return { lines: head.subarray(0, EDIT_MAX_BYTES).toString('utf8').split(/\r?\n/), cut: text.length > EDIT_MAX_BYTES || head.length > EDIT_MAX_BYTES };
}

/** The removed and added text of an Edit, MultiEdit or Write tool input; null when it carries none (classed by path only). */
function editTexts(toolInput) {
  const asText = (value) => (typeof value === 'string' ? value : '');
  if (typeof toolInput?.content === 'string') return { removed: '', added: toolInput.content };
  const edits = Array.isArray(toolInput?.edits) ? toolInput.edits : [toolInput ?? {}];
  const removed = edits.map((edit) => asText(edit?.old_string)).join('\n');
  const added = edits.map((edit) => asText(edit?.new_string)).join('\n');
  return removed === '' && added === '' ? null : { removed, added };
}

/**
 * The reminder groups an edit calls for: look (look, global look), logic, text; none for tests, docs pages, dev config and deps.
 * @param {string} file the edited path
 * @param {object} toolInput the Edit, MultiEdit or Write input (old_string/new_string, edits[], content)
 * @param {boolean} uiFile the path is UI source (skill-router isUiFile); otherwise only locale and global-look files are reminded
 * @returns {string[]} groups in EDIT_GROUPS order
 */
export function editGroups(file, toolInput, uiFile) {
  const texts = editTexts(toolInput);
  const removed = texts && cappedLines(texts.removed);
  const added = texts && cappedLines(texts.added);
  const cut = Boolean(removed?.cut || added?.cut);
  const classes = [...classifyFile(file, removed?.lines ?? null, added?.lines ?? null), ...(cut ? classifyFile(file, null, null) : [])];
  const kept = uiFile ? classes : classes.filter((name) => PATH_CLASSES.has(name));
  const groups = new Set(kept.map((name) => GROUP_OF_CLASS[name]).filter(Boolean));
  return EDIT_GROUPS.filter((group) => groups.has(group));
}

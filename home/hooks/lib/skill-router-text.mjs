// The texts the skill router (hooks/skill-router.mjs) adds to a prompt or after a UI-file edit, split out to keep that hook under 300 lines (C4).
// Exports: fullPromptText(skills), shortPromptText(skills), FOLLOW_UP_SHORT_TEXT, planPromptText(skills), PLAN_FOLLOW_UP_TEXT, EDIT_TEXTS.
// Invariants: pure strings, sized by the evidence (owner R24/R28): the pixel texts (a design word or Figma link in the request, and
// follow-ups in such a session) name the proof step (`ui-check run` rounds in the UI lane, then visual-qa's final gate), word for word as
// before; every other UI text is one line that names its skills and leaves the depth to the check plan (`ui-proof plan`).

const PROOF_STEP = ' Proof before "done" or "fixed": the UI lane runs `ui-check run` rounds until every state passes, then a' +
  ' `visual-qa` lane runs the final gate on the tree that lands; only its PASS counts.';
const PROOF_SHORT = 'proof: ui-check run PASS, then the visual-qa final gate';

/** The full routing text for a prompt that routes `skills` (first routed prompt of a session, or a skill not named before). */
export const fullPromptText = (skills) =>
  `Skill router: this request involves UI. Before writing UI code, invoke with the Skill tool: ${skills.join(', ')}` +
  ' (skip any already loaded in this context). A project skill with the same purpose whose paths match wins.' +
  ' Delegate UI implementation to the `ui-implementer` agent, not `implementer`, and name these skills in the' +
  ' delegation prompt (a project\'s own `ui-implementer` preloads only project skills);' +
  ` run \`ui-quality-pass\` before saying done.${PROOF_STEP}`;

/** The one-line form for a prompt whose skills were all named earlier in the session. */
export const shortPromptText = (skills) =>
  `Skill router: UI request - invoke ${skills.join(', ')} (skip any already loaded); delegate to ui-implementer; ` +
  `ui-quality-pass before done; ${PROOF_SHORT}.`;

/** The one-line UI follow-up ("continue", weak UI words in a UI session) once the full text is in context. */
export const FOLLOW_UP_SHORT_TEXT = 'Skill router: UI follow-up - invoke accessibility-build, responsive-ui (skip any already loaded); ' +
  `delegate to ui-implementer; ui-quality-pass before done; ${PROOF_SHORT}.`;

const PLAN_STEP = 'the check plan decides the depth (standards/ui-checks.md, `ui-proof plan`)';

/** The one line for a UI change request with no design evidence: its skills, ui-quality-pass, and the check plan for the depth. */
export const planPromptText = (skills) => {
  const invoke = skills.filter((skill) => skill !== 'ui-quality-pass');
  return `Skill router: UI change - ${invoke.length ? `invoke ${invoke.join(', ')} (skip any already loaded); ` : ''}ui-quality-pass before done; ${PLAN_STEP}.`;
};

/** The UI follow-up line ("continue", weak UI words) in a UI session with no design evidence. */
export const PLAN_FOLLOW_UP_TEXT = 'Skill router: UI follow-up - invoke accessibility-build, responsive-ui (skip any already loaded); ' +
  `ui-quality-pass before done; ${PLAN_STEP}.`;

/** The reminder per class of the edited lines (skill-router-routes.mjs EDIT_GROUPS), each once per session and agent. */
export const EDIT_TEXTS = Object.freeze({
  look: 'Skill router: you are editing UI look. If not yet loaded in this context, invoke `responsive-ui` and `accessibility-build` now' +
    ' (`figma-pixel-perfect` when there is a Figma frame), and run `ui-quality-pass` before reporting done; ' + `${PLAN_STEP}.`,
  logic: 'Skill router: you are editing UI logic. If not yet loaded, invoke `async-ui-states` for server data and `forms-validation`' +
    ' for forms, and add or update a test for the changed logic.',
  text: 'Skill router: you are editing UI text. Invoke `ui-coverage` and check the change in every locale (RTL included).',
});

// The texts the skill router (hooks/skill-router.mjs) adds to a prompt or after a UI-file edit, split out to keep that hook under 300 lines (C4).
// Exports: fullPromptText(skills), shortPromptText(skills), FOLLOW_UP_SHORT_TEXT, EDIT_REMINDER_TEXT.
// Invariants: pure strings; every UI text names the proof step (`ui-check run` rounds in the UI lane, then visual-qa's final gate on the tree that lands).

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

/** The reminder after the first UI-file edit of a session and agent. */
export const EDIT_REMINDER_TEXT = 'Skill router: you are editing UI code. If not yet loaded in this context, invoke `responsive-ui` and' +
  ' `accessibility-build` now (also `forms-validation` for forms, `async-ui-states` for server data,' +
  ' `figma-pixel-perfect` when there is a Figma frame), and run `ui-quality-pass` before reporting done.' +
  ' Proof: `ui-check run` until every state passes; visual-qa runs the final gate on the tree that lands.';

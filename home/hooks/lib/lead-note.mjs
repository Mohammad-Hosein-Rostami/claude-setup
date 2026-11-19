// Lead-model note for the mode hook. Exports: leadNote({ mode, model, previousMode, launchedAs }).
// Invariants: pure (no I/O); the note only names the `ccm` launch line, because a hook cannot change the lead model or effort.
// The session model comes from the hook input, so it is printed only as id characters (A-Z a-z 0-9 _ . - [ ]) and at most
// MODEL_ID_SHOWN_CHARS of them: no line break, tag or long text reaches the SessionStart output through it.

// Modes that set the lead at launch: model alias to look for, display name, default launch effort (CCM_LEAD_EFFORT may override).
const LEAD_MODES = {
  'extra-high': { alias: 'opus', label: 'Opus 5.5', effort: 'max' },
  'ultra-high': { alias: 'fable', label: 'Fable 5.2', effort: 'high' },
};
const BASE_LEAD = 'Opus 5.5 at high';
const NOT_A_MODEL_ID_CHAR = /[^A-Za-z0-9_.\-[\]]/g;
const MODEL_ID_SHOWN_CHARS = 64; // a real id is under 40 characters, also with a `[1m]` suffix
const UNNAMED_MODEL = 'another model';

/** The session model as the note shows it: its id characters only, cut to MODEL_ID_SHOWN_CHARS. */
function shownModel(model) {
  return model.replace(NOT_A_MODEL_ID_CHAR, '').slice(0, MODEL_ID_SHOWN_CHARS) || UNNAMED_MODEL;
}

function launchCommand(mode) {
  return `ccm ${mode} -c`;
}

/**
 * One line telling the user how to get the lead that a mode needs, or '' when nothing is to be said.
 * A switch (previousMode given) into extra-high / ultra-high always gets the launch note, because the hook cannot
 * see or change the lead; a switch out of them says the lead is still at its launch effort. A base mode (normal /
 * medium / high) gets a note when the session model is known and is not Opus, so a resume that kept Fable or Sonnet is
 * pointed to `ccm <mode> -c`; with no model or an empty one it stays silent. At session start (no previousMode)
 * the note appears when the process was not launched with `ccm <mode>` (launchedAs differs: its --model/--effort
 * flags are missing, e.g. a plain `claude --resume`) or when the session model is known and does not match.
 * @param {{mode: string, model?: string, previousMode?: string, launchedAs?: string}} state - active mode, session
 *   model if known, the mode before a `/mode` switch, and env CLAUDE_MODE at session start.
 * @returns {string} the note, or ''.
 */
export function leadNote({ mode, model, previousMode, launchedAs }) {
  const lead = LEAD_MODES[mode];
  const switched = previousMode !== undefined && previousMode !== mode;
  if (lead) {
    const wrongModel = typeof model === 'string' && model !== '' && !model.toLowerCase().includes(lead.alias);
    const mismatch = wrongModel || (launchedAs !== undefined && launchedAs !== mode);
    if (launchedAs === mode && !wrongModel) return ''; // `ccm <mode>` set the lead for this process
    if (!switched && !mismatch) return '';
    return `The lead model/effort for ${mode} is set at launch: tell the user to run \`${launchCommand(mode)}\` to continue this conversation with ${lead.label} at ${lead.effort} effort (avoid \`/model\`: it saves machine-wide).`;
  }
  const left = switched ? LEAD_MODES[previousMode] : undefined;
  if (!left) {
    if (typeof model !== 'string' || model === '' || model.toLowerCase().includes('opus')) return '';
    return `The lead for ${mode} is ${BASE_LEAD} but this session runs ${shownModel(model)}: tell the user to run \`${launchCommand(mode)}\` (or \`ccm ${mode} --resume <id>\`) to switch it back (avoid \`/model\`: it saves machine-wide).`;
  }
  return `The lead is still ${left.label} at ${left.effort}: tell the user to run \`${launchCommand(mode)}\` to return it to ${BASE_LEAD}.`;
}

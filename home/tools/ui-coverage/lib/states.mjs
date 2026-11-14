// Purpose: the ONE place that lists the default states per control class, so a control cannot silently skip hover, open,
// error and so on. The skill, the README and the figma standard point here (`ui-coverage.mjs states` prints it).
// Exports: OTHER_CLASS, defaultStatesFor(controlClass), isKnownClass(controlClass), knownClassNames(), describeStates().
// Invariants: class names are matched case-insensitively with spaces, dashes and underscores ignored. `other` is known
// but has no defaults (its states must be listed by hand); any other unknown name is not known (a schema error).

export const OTHER_CLASS = 'other';

const GROUPS = [
  { aliases: ['select', 'dropdown', 'menu', 'autocomplete', 'combobox'], states: ['rest', 'focus', 'open', 'option-hover', 'selected', 'disabled', 'error'] },
  { aliases: ['checkbox', 'radio', 'switch'], states: ['unchecked', 'checked', 'indeterminate', 'focus', 'disabled', 'error'] },
  { aliases: ['textfield', 'input', 'textinput'], states: ['empty', 'focus', 'filled', 'error', 'success', 'disabled'] },
  { aliases: ['button'], states: ['rest', 'hover', 'focus', 'active', 'disabled', 'loading'] },
  { aliases: ['dialog', 'toast', 'tooltip', 'popover', 'overlay'], states: ['shown'] },
  { aliases: ['async', 'asyncsurface'], states: ['loading', 'empty', 'error'] },
];

const DEFAULTS_BY_ALIAS = new Map(GROUPS.flatMap((group) => group.aliases.map((alias) => [alias, group.states])));
const normalize = (name) => name.toLowerCase().replace(/[\s_-]+/g, '');

/** True when `controlClass` is `other` or an alias of a default-state group. */
export function isKnownClass(controlClass) {
  return typeof controlClass === 'string' && (normalize(controlClass) === OTHER_CLASS || DEFAULTS_BY_ALIAS.has(normalize(controlClass)));
}

/** Returns the accepted class names (aliases plus `other`), for error messages. */
export const knownClassNames = () => [...DEFAULTS_BY_ALIAS.keys(), OTHER_CLASS];

/**
 * Returns the states every control of this class must cover (or drop with a reason).
 * @param {unknown} controlClass the `class` field of a control, e.g. "text field" or "Dropdown"
 * @returns {string[]} the default states, empty for `other` or an unknown class
 */
export function defaultStatesFor(controlClass) {
  return typeof controlClass === 'string' ? (DEFAULTS_BY_ALIAS.get(normalize(controlClass)) ?? []) : [];
}

/** Returns one line per group: `aliases -> states`, for the `states` command. */
export const describeStates = () => GROUPS.map((group) => `${group.aliases.join('|')} -> ${group.states.join(', ')}`);

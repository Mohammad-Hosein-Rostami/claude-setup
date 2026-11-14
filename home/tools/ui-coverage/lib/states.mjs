// Purpose: the default state set per control class, so a control cannot silently skip hover, open, error and so on.
// Exports: defaultStatesFor(controlClass).
// Invariants: class names are matched case-insensitively with spaces, dashes and underscores ignored; an unknown class
// has no defaults (returns []), so the matrix stays usable for custom controls.

const SELECT = ['rest', 'focus', 'open', 'option-hover', 'selected', 'disabled', 'error'];
const TOGGLE = ['unchecked', 'checked', 'indeterminate', 'focus', 'disabled', 'error'];
const TEXT_FIELD = ['empty', 'focus', 'filled', 'error', 'success', 'disabled'];
const BUTTON = ['rest', 'hover', 'focus', 'active', 'disabled', 'loading'];
const OVERLAY = ['shown'];
const ASYNC_SURFACE = ['loading', 'empty', 'error'];

const DEFAULTS_BY_ALIAS = new Map([
  ...['select', 'dropdown', 'menu', 'autocomplete', 'combobox'].map((alias) => [alias, SELECT]),
  ...['checkbox', 'radio', 'switch'].map((alias) => [alias, TOGGLE]),
  ...['textfield', 'input', 'textinput'].map((alias) => [alias, TEXT_FIELD]),
  ['button', BUTTON],
  ...['dialog', 'toast', 'tooltip', 'popover', 'overlay'].map((alias) => [alias, OVERLAY]),
  ...['async', 'asyncsurface'].map((alias) => [alias, ASYNC_SURFACE]),
]);

/**
 * Returns the states every control of this class must cover (or drop with a reason).
 * @param {unknown} controlClass the `class` field of a control, e.g. "text field" or "Dropdown"
 * @returns {string[]} the default states, empty for an unknown class
 */
export function defaultStatesFor(controlClass) {
  if (typeof controlClass !== 'string') return [];
  return DEFAULTS_BY_ALIAS.get(controlClass.toLowerCase().replace(/[\s_-]+/g, '')) ?? [];
}

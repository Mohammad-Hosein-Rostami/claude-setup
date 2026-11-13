// Shared wording for guard reasons: a destructive rule's reason starts with DESTRUCTIVE_PREFIX so its dialog stands out.
// Exports: DESTRUCTIVE_PREFIX, destructive(what) -> reason.
export const DESTRUCTIVE_PREFIX = 'DESTRUCTIVE: ';
export const destructive = (what) => `${DESTRUCTIVE_PREFIX}${what}`;

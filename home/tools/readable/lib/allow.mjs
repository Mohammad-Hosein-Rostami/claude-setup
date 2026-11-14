// Purpose: read the optional `.readable.json` allow-list that lets a project keep a dumping-ground name on purpose.
// Exports: parseAllowList(text).
// Invariants: pure; format is {"allow": [{"path": "src/utils", "reason": "why this name is fine"}]}; an entry without a
//   reason is not applied and is reported as a problem, so the list can never hide a finding silently.

/**
 * @param {string|null} text content of .readable.json, or null when the file does not exist
 * @returns {{allowed: Set<string>, problems: string[]}}
 */
export function parseAllowList(text) {
  const allowed = new Set();
  const problems = [];
  if (text === null) return { allowed, problems };
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) {
    return { allowed, problems: [`.readable.json is not valid JSON (${error.message}).`] };
  }
  const entries = Array.isArray(parsed?.allow) ? parsed.allow : [];
  for (const entry of entries) {
    const path = typeof entry?.path === 'string' ? entry.path.replace(/\/+$/, '') : '';
    const reason = typeof entry?.reason === 'string' ? entry.reason.trim() : '';
    if (path === '') problems.push('.readable.json has an allow entry with no "path".');
    else if (reason === '') problems.push(`.readable.json allows "${path}" without a "reason"; add one or remove the entry.`);
    else allowed.add(path);
  }
  return { allowed, problems };
}

// Turns collected facts into the text the tool prints for `list` (see ../README.md for the layout).
// Exports: formatList(data) -> string.
// Invariants: pure; the text is built from names, counts and `file:line` references only.
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function envFileLine(file) {
  if (file.status !== undefined) return `${file.path}  (${file.status})`;
  const other = file.otherLines > 0 ? `, ${plural(file.otherLines, 'other line')}` : '';
  return `${file.path}  (${plural(file.names.length, 'name')}${other})`;
}

const sectionOf = (title, rows) => [`${title} (${rows.length}):`, ...rows.map((row) => `  ${row}`), ''];

/** One line per name that differs: who has it and who lacks it. */
const differingLine = ({ name, has, lacks }) => `${name}  in ${has.join(', ')}; not in ${lacks.join(', ')}`;

/** The optional sections: they only appear when there is something to say. */
function extraSections(data) {
  const builtinNames = Object.keys(data.builtin);
  const dynamicFiles = Object.entries(data.dynamic);
  const lines = [];
  if (builtinNames.length > 0) lines.push(`Vite built-ins read (${builtinNames.length}): ${builtinNames.join(', ')}`, '');
  if (dynamicFiles.length > 0) lines.push(`Dynamic access (${plural(dynamicFiles.length, 'file')}):`, ...dynamicFiles.map(([path, count]) => `  ${path}  ${count}`), '');
  if (data.notRead.length > 0) lines.push(...sectionOf('Not read', data.notRead.map(({ path, reason }) => `${path}  ${reason}`)));
  return lines;
}

/**
 * @param {object} data the collected snapshot object
 * @returns {string} the report, ending with the summary line
 */
export function formatList(data) {
  const { summary } = data;
  const lines = [
    ...sectionOf('Env files', data.envFiles.map(envFileLine)),
    ...sectionOf('Read by code but defined in no env file', data.undefinedNames.map(({ name, firstUse }) => `${name}  ${firstUse}`)),
    ...sectionOf('Defined but never read by code or deploy files', data.neverRead.map(({ name, files }) => `${name}  ${files.join(', ')}`)),
    ...sectionOf('Names that differ between env files of the same folder', data.differing.map(differingLine)),
    ...extraSections(data),
    `env-names: ${summary.envFiles} env files, ${summary.definedNames} defined names, ${summary.readNames} names read by code, values never read`,
  ];
  return lines.join('\n');
}

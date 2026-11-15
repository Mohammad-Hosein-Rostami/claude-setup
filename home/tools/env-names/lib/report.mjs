// Turns collected facts and diffs into the text the tool prints (see ../README.md for the layout).
// Exports: formatList(data) -> string; formatDiff(diff) -> string.
// Invariants: pure; the text is built from names, counts and `file:line` references only.
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function envFileLine(file) {
  if (file.status !== undefined) return `${file.path}  (${file.status})`;
  const other = file.otherLines > 0 ? `, ${plural(file.otherLines, 'other line')}` : '';
  const hidden = file.hiddenNames > 0 ? `, ${plural(file.hiddenNames, 'name')} not shown (mixed case or too long)` : '';
  return `${file.path}  (${plural(file.names.length, 'name')}${other}${hidden})`;
}

const sectionOf = (title, rows, count = rows.length) => [`${title} (${count}):`, ...rows.map((row) => `  ${row}`), ''];

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

const refsLine = ({ name, refs }) => `${name}  ${refs.join(', ')}`;

/** A removed or added env file, with the extra line when another file holds exactly the same names. */
const envFileRows = (files) => files.flatMap(({ path, sameNamesAs }) => (sameNamesAs === undefined ? [path] : [path, `  same names as ${sameNamesAs}`]));

const nameChangeLine = ({ path, added, removed }) => `${path}  ${[...added.map((name) => `+${name}`), ...removed.map((name) => `-${name}`)].join(' ')}`;

/**
 * @param {object} diff the result of diffSnapshots
 * @returns {string} the sections that have rows ("Now undefined" first), then one closing line
 */
export function formatDiff(diff) {
  const optional = (title, rows, count = rows.length) => (rows.length > 0 ? sectionOf(title, rows, count) : []);
  const lines = [
    ...optional('Now undefined', diff.nowUndefined.map(({ name, firstUse, wasIn }) => `${name}  ${firstUse} (was defined in ${wasIn.join(', ')})`)),
    ...optional('Env files added', envFileRows(diff.envFiles.added), diff.envFiles.added.length),
    ...optional('Env files removed', envFileRows(diff.envFiles.removed), diff.envFiles.removed.length),
    ...optional('Names changed in env files', diff.namesChanged.map(nameChangeLine)),
    ...optional('Names read by code added', diff.readByCode.added.map(refsLine)),
    ...optional('Names read by code removed', diff.readByCode.removed.map(refsLine)),
    ...optional('Names in deploy files added', diff.deploy.added.map(refsLine)),
    ...optional('Names in deploy files removed', diff.deploy.removed.map(refsLine)),
    `env-names: ${diff.changed ? 'changes' : 'no changes'} since ${diff.since}`,
  ];
  return lines.join('\n');
}

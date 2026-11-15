// Finds the environment variable names of a YAML deploy file (compose, GitHub workflow, GitLab CI) from the PARSED structure.
// Exports: loadYamlParser(packageDir), yamlParserInstalled (boolean), scanYamlDeploy(kind, text) -> { found, notNames, untrusted, work }.
// Invariants: a name comes only from a map KEY (a plain or quoted string scalar) or from the text before the first `=` of a
//   string list item, at one of the env positions: compose `services.*.environment` (map or list), GitLab `variables` (top level
//   and per job), workflow `env` (top level, job, step). Values, sub-keys of a variable's map, anchors, tags and comments are
//   never read into the result. The parse is strict. A document with any error or warning, a scalar key twice in one map
//   (surveyDocument), more than MAX_ALIASES aliases, an alias that does not resolve, a self-merging map, a walk over its work limit,
//   a character other parsers read as a line break (LINE_BREAK_OR_CONTROL), or a parser that throws makes the whole file
//   `untrusted`: the caller then prints a name only when code reads it too. Aliases are followed one at a time, never expanded
//   into plain data (no `toJS`), so an alias bomb costs nothing. Nothing from the parser's messages (they quote source text) is kept.
// The parser is loaded from this tool's own node_modules by file URL (see loadYamlParser), never by the bare name `yaml`, so a
//   `node_modules/yaml` in a parent folder or in the scanned project is never used. If it is not there, YAML files are skipped.
// Characters that other YAML parsers read as line breaks or reject make the file untrusted (see LINE_BREAK_OR_CONTROL).
const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';
const MAX_ALIASES = 100; // the parser library's own default limit for aliases in one document
const WORK_PER_CHARACTER = 4; // pairs and characters examined per character of the file; real files use about 1
const MAX_RESOLUTIONS = 1000; // alias lookups while walking: a merge of merges repeats lookups, so this stops a chain that doubles at each level
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `$${NAME}` is compose's escape for a literal `${NAME}`: not a substitution.
const SUBSTITUTION = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
// The words secrets.X and vars.X count only inside a `${{ ... }}` expression, which expressionSpans cuts out first.
const CI_REFERENCE = /\b(?:secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g;
const REFERENCE_PATTERN = { compose: SUBSTITUTION, workflow: CI_REFERENCE, gitlab: CI_REFERENCE };
// Characters that this parser (YAML 1.2) keeps inside a comment or a scalar but that other YAML parsers (Go yaml.v3 in Docker
// Compose, Ruby Psych in GitLab, PyYAML) read as a line break or reject: a lone CR, C0 controls except tab, LF and CR, DEL, the C1
// controls (including U+0085 NEL), U+2028, U+2029. A BOM anywhere but the first character is checked separately. Where the
// parsers disagree about what is a line, a "comment" may hide a key or a block scalar, so a file with one is untrusted.
const LINE_BREAK_OR_CONTROL = /\r(?!\n)|[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/;
const BYTE_ORDER_MARK = '\uFEFF';

const PACKAGE_DIR = new URL('../node_modules/yaml/', import.meta.url);

/**
 * Imports the `yaml` package that sits in `packageDir`, using the entry file its package.json names for Node.
 * @param {URL} packageDir the package folder (default: this tool's own node_modules/yaml, under the tool's real path)
 * @returns the parser module, or null when the folder or its entry file is missing
 */
export async function loadYamlParser(packageDir = PACKAGE_DIR) {
  try {
    const manifest = (await import(new URL('package.json', packageDir).href, { with: { type: 'json' } })).default;
    return await import(new URL(manifest.exports['.'].node, packageDir).href);
  } catch (error) {
    if (error.code !== MODULE_NOT_FOUND) throw error;
    return null;
  }
}

const yaml = await loadYamlParser();
export const yamlParserInstalled = yaml !== null;

/**
 * Walking state for one document (`workSoFar`: the work of the documents before it, so the limit is one for the whole file).
 * `work` counts the pairs and characters examined; once it passes `workLimit` (proportional to the size of the file) merges are
 * no longer followed and the file is untrusted, so a map merged by thousands of services cannot make the walk slow.
 */
function newWalk(doc, lineCounter, textLength, workSoFar) {
  const workLimit = WORK_PER_CHARACTER * textLength;
  return { doc, lineCounter, workLimit, work: workSoFar, found: [], notNames: 0, untrusted: false, resolved: 0, targets: new Map() };
}

const lineOf = (walk, node) => walk.lineCounter.linePos(node.range[0]).line;
const isMergeKey = (key) => yaml.isScalar(key) && typeof key.value === 'symbol';
const keyId = (pair) => (yaml.isScalar(pair.key) ? pair.key.value : pair.key); // a non-scalar key is its own identity
const isKeyNamed = (key, name) => yaml.isScalar(key) && key.value === name;

/** The node an alias points to (or the node itself); marks the walk untrusted when the alias cannot be followed. */
function follow(node, walk) {
  if (!yaml.isAlias(node)) return node;
  walk.resolved += 1;
  const target = walk.resolved > MAX_RESOLUTIONS ? undefined : walk.targets.get(node);
  if (target === undefined) walk.untrusted = true;
  return target;
}

/**
 * The key/value pairs of a map, with merge keys (`<<: *alias`, `<<: [*a, *b]`) replaced by the pairs they bring. An explicit pair
 * wins over a merged one and an earlier merge source over a later one, as in YAML: a key is listed once. A map that merges itself
 * and a walk over its work limit make the file untrusted (no merging from then on).
 */
function mapPairs(map, walk, visiting = new Set()) {
  walk.work += map.items.length;
  if (visiting.has(map)) {
    walk.untrusted = true;
    return [];
  }
  const pairs = map.items.filter((pair) => !isMergeKey(pair.key));
  if (walk.work > walk.workLimit) {
    walk.untrusted = true;
    return pairs;
  }
  visiting.add(map);
  const listed = new Set(pairs.map(keyId));
  for (const pair of map.items.filter((item) => isMergeKey(item.key))) {
    const sources = yaml.isSeq(pair.value) ? pair.value.items : [pair.value];
    for (const source of sources.map((item) => follow(item, walk))) {
      if (!yaml.isMap(source)) {
        walk.untrusted = true; // a merge source that is not a map: the real consumer may read it differently
        continue;
      }
      for (const merged of mapPairs(source, walk, visiting)) {
        if (listed.has(keyId(merged))) continue;
        listed.add(keyId(merged));
        pairs.push(merged);
      }
    }
  }
  visiting.delete(map);
  return pairs;
}

/** The value under `key` of a map node (after following an alias), or undefined. */
function valueAt(node, key, walk) {
  const map = follow(node, walk);
  if (!yaml.isMap(map)) return undefined;
  return follow(mapPairs(map, walk).find((pair) => isKeyNamed(pair.key, key))?.value, walk);
}

/** The values of a map, or the items of a list, after following aliases; `skipKey` leaves one map key out. */
function childrenOf(node, walk, skipKey) {
  const parent = follow(node, walk);
  if (yaml.isSeq(parent)) return parent.items.map((item) => follow(item, walk));
  if (!yaml.isMap(parent)) return [];
  return mapPairs(parent, walk).filter((pair) => !isKeyNamed(pair.key, skipKey)).map((pair) => follow(pair.value, walk));
}

/** Records the names of an env position: map keys, and (when `allowList`) the text before the first `=` of string list items. */
function collectNames(node, walk, allowList) {
  const target = follow(node, walk);
  if (yaml.isMap(target)) {
    for (const { key } of mapPairs(target, walk)) {
      const isName = yaml.isScalar(key) && typeof key.value === 'string' && NAME_SHAPE.test(key.value);
      if (isName) walk.found.push({ name: key.value, line: lineOf(walk, key), keyed: true });
      else walk.notNames += 1;
    }
  } else if (allowList && yaml.isSeq(target)) {
    for (const item of target.items.map((entry) => follow(entry, walk))) {
      const name = yaml.isScalar(item) && typeof item.value === 'string' ? item.value.split('=', 1)[0] : '';
      if (NAME_SHAPE.test(name)) walk.found.push({ name, line: lineOf(walk, item), keyed: false });
      else walk.notNames += 1;
    }
  }
}

/** Reads every env position of one document. */
const POSITIONS = {
  compose: (root, walk) => {
    for (const service of childrenOf(valueAt(root, 'services', walk), walk)) collectNames(valueAt(service, 'environment', walk), walk, true);
  },
  gitlab: (root, walk) => {
    collectNames(valueAt(root, 'variables', walk), walk, false);
    for (const job of childrenOf(root, walk, 'variables')) collectNames(valueAt(job, 'variables', walk), walk, false);
  },
  workflow: (root, walk) => {
    collectNames(valueAt(root, 'env', walk), walk, false);
    for (const job of childrenOf(valueAt(root, 'jobs', walk), walk)) {
      collectNames(valueAt(job, 'env', walk), walk, false);
      for (const step of childrenOf(valueAt(job, 'steps', walk), walk)) collectNames(valueAt(step, 'env', walk), walk, false);
    }
  },
};

/** The text inside each closed `${{ ... }}` of `source`, with its offset; one forward pass, so a long text with no `}}` costs one scan. */
function expressionSpans(source, walk) {
  const spans = [];
  let from = 0;
  for (let open = source.indexOf('${{', from); open !== -1; open = source.indexOf('${{', from)) {
    const close = source.indexOf('}}', open + 3);
    walk.work += (close === -1 ? source.length : close) - open;
    if (close === -1) break;
    spans.push({ text: source.slice(open + 3, close), offset: open + 3 });
    from = close + 2;
  }
  return spans;
}

/** Every match of `pattern` in the scalar's source text (or, for CI kinds, inside its `${{ }}` expressions) as `{ name, offset }`. */
function referencesIn(kind, source, walk) {
  const parts = kind === 'compose' ? [{ text: source, offset: 0 }] : expressionSpans(source, walk);
  return parts.flatMap(({ text, offset }) => [...text.matchAll(REFERENCE_PATTERN[kind])].map((match) => ({ name: match[1], offset: offset + match.index })));
}

/** `${NAME}` substitutions (compose) or `secrets.NAME` / `vars.NAME` references (CI) inside scalar values. */
function collectReferences(kind, text, walk) {
  yaml.visit(walk.doc, {
    Scalar: (_key, node) => {
      const [start, end] = node.range;
      walk.work += end - start;
      for (const { name, offset } of referencesIn(kind, text.slice(start, end), walk)) {
        walk.found.push({ name, line: walk.lineCounter.linePos(start + offset).line, keyed: true });
      }
    },
  });
}

/**
 * One pass over the whole document: finds the node each alias points to (the last node with that anchor before the alias, as YAML
 * says; the library's own `Alias.resolve` would also expand the node), and marks the walk untrusted for more aliases than
 * MAX_ALIASES or a scalar key twice in one map. The parser's `uniqueKeys` check compares every pair of keys of a map (6 seconds
 * for one map of 35,000 keys), so the duplicate check is done here in linear time.
 */
function surveyDocument(walk) {
  const latestByAnchor = new Map();
  let aliases = 0;
  yaml.visit(walk.doc, (_key, node) => {
    if (yaml.isAlias(node)) {
      aliases += 1;
      walk.targets.set(node, latestByAnchor.get(node.source));
      if (!walk.targets.get(node)) walk.untrusted = true; // an alias to an anchor that is not defined before it (the parser does not report this)
    } else if (yaml.isNode(node) && node.anchor) {
      latestByAnchor.set(node.anchor, node);
    }
    if (yaml.isMap(node)) {
      const keys = node.items.filter((pair) => yaml.isScalar(pair.key) && typeof pair.key.value !== 'symbol').map((pair) => pair.key.value);
      if (new Set(keys).size < keys.length) walk.untrusted = true;
    }
  });
  if (aliases > MAX_ALIASES) walk.untrusted = true;
}

/** True when the text holds a character that other YAML parsers read as a line break or reject (see LINE_BREAK_OR_CONTROL). */
function hasForeignCharacters(text) {
  const afterBom = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  return LINE_BREAK_OR_CONTROL.test(afterBom) || afterBom.includes(BYTE_ORDER_MARK);
}

/**
 * @param {'compose'|'workflow'|'gitlab'} kind
 * @param {string} text the file content
 * @returns {{ found: { name: string, line: number, keyed: boolean }[], notNames: number, untrusted: boolean, work: number }}
 *   `found`: names at env positions and references in values (the caller applies the name-shape rule); `notNames`: keys and items
 *   at env positions that are not names (numbers, null, maps, text with spaces), counted and never printed; `untrusted`: see header;
 *   `work`: pairs and characters examined, which stays within WORK_PER_CHARACTER times the length of the text.
 */
export function scanYamlDeploy(kind, text) {
  const lineCounter = new yaml.LineCounter();
  const options = { strict: true, uniqueKeys: false, merge: true, logLevel: 'silent', prettyErrors: false, lineCounter };
  const result = { found: [], notNames: 0, untrusted: hasForeignCharacters(text), work: 0 };
  try {
    for (const doc of yaml.parseAllDocuments(text, options)) {
      const walk = newWalk(doc, lineCounter, text.length, result.work);
      if (doc.errors.length > 0 || doc.warnings.length > 0) walk.untrusted = true;
      if (doc.contents !== null) {
        surveyDocument(walk);
        POSITIONS[kind](doc.contents, walk);
        collectReferences(kind, text, walk);
      }
      for (const entry of walk.found) result.found.push(entry); // not push(...list): a big file would overflow the call stack
      result.notNames += walk.notNames;
      result.work = walk.work;
      result.untrusted ||= walk.untrusted;
    }
  } catch {
    return { found: [], notNames: 0, untrusted: true, work: result.work }; // the parser threw (for example a stack overflow on absurd nesting)
  }
  return result;
}

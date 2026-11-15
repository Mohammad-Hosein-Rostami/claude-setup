// Finds the environment variable names of a YAML deploy file (compose, GitHub workflow, GitLab CI) from the PARSED structure.
// Exports: yamlParserInstalled (boolean), scanYamlDeploy(kind, text) -> { found, notNames, untrusted }.
// Invariants: a name comes only from a map KEY (a plain or quoted string scalar) or from the text before the first `=` of a
//   string list item, at one of the env positions: compose `services.*.environment` (map or list), GitLab `variables` (top level
//   and per job), workflow `env` (top level, job, step). Values, sub-keys of a variable's map, anchors, tags and comments are
//   never read into the result. The parse is strict. A document with any error or warning, a scalar key twice in one map
//   (surveyDocument), more than MAX_ALIASES aliases, an alias that does not resolve, or a parser that throws makes the whole file
//   `untrusted`: the caller then prints a name only when code reads it too. Aliases are followed one at a time, never expanded
//   into plain data (no `toJS`), so an alias bomb costs nothing. Nothing from the parser's messages (they quote source text) is kept.
// Seam for tests: the environment variable ENV_NAMES_YAML_MODULE replaces the module name `yaml`, to simulate a missing parser.
const MODULE_NOT_FOUND = 'ERR_MODULE_NOT_FOUND';
const MAX_ALIASES = 100; // the parser library's own default limit for aliases in one document
const MAX_RESOLUTIONS = 1000; // alias lookups while walking: a merge of merges repeats lookups, so this stops a chain that doubles at each level
const NAME_SHAPE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// `$${NAME}` is compose's escape for a literal `${NAME}`: not a substitution.
const SUBSTITUTION = /(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
// Only inside a `${{ ... }}` expression: the words secrets.X in a plain string are text, not a reference.
const CI_REFERENCE = /(?<=\$\{\{[^}]*)\b(?:secrets|vars)\.([A-Za-z_][A-Za-z0-9_]*)/g;
const REFERENCE_PATTERN = { compose: SUBSTITUTION, workflow: CI_REFERENCE, gitlab: CI_REFERENCE };

let yaml = null;
try {
  yaml = await import(process.env.ENV_NAMES_YAML_MODULE ?? 'yaml');
} catch (error) {
  if (error.code !== MODULE_NOT_FOUND) throw error;
}

export const yamlParserInstalled = yaml !== null;

/** Walking state for one file: the document being read, its line counter, and what made the file untrusted. */
function newWalk(doc, lineCounter) {
  return { doc, lineCounter, found: [], notNames: 0, untrusted: false, resolved: 0, targets: new Map() };
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
 * wins over a merged one and an earlier merge source over a later one, as in YAML: a key is listed once.
 */
function mapPairs(map, walk, visiting = new Set()) {
  if (visiting.has(map)) return [];
  visiting.add(map);
  const pairs = map.items.filter((pair) => !isMergeKey(pair.key));
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

/** `${NAME}` substitutions (compose) or `secrets.NAME` / `vars.NAME` references (CI) inside scalar values. */
function collectReferences(kind, text, walk) {
  yaml.visit(walk.doc, {
    Scalar: (_key, node) => {
      const [start, end] = node.range;
      for (const match of text.slice(start, end).matchAll(REFERENCE_PATTERN[kind])) {
        walk.found.push({ name: match[1], line: walk.lineCounter.linePos(start + match.index).line, keyed: true });
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

/**
 * @param {'compose'|'workflow'|'gitlab'} kind
 * @param {string} text the file content
 * @returns {{ found: { name: string, line: number, keyed: boolean }[], notNames: number, untrusted: boolean }}
 *   `found`: names at env positions and references in values (the caller applies the name-shape rule); `notNames`: keys and items
 *   at env positions that are not names (numbers, null, maps, text with spaces), counted and never printed; `untrusted`: see header.
 */
export function scanYamlDeploy(kind, text) {
  const lineCounter = new yaml.LineCounter();
  const options = { strict: true, uniqueKeys: false, merge: true, logLevel: 'silent', prettyErrors: false, lineCounter };
  const result = { found: [], notNames: 0, untrusted: false };
  try {
    const documents = [...yaml.parseAllDocuments(text, options)];
    for (const doc of documents) {
      const walk = newWalk(doc, lineCounter);
      if (doc.errors.length > 0 || doc.warnings.length > 0) walk.untrusted = true;
      if (doc.contents !== null) {
        surveyDocument(walk);
        POSITIONS[kind](doc.contents, walk);
        collectReferences(kind, text, walk);
      }
      for (const entry of walk.found) result.found.push(entry); // not push(...list): a big file would overflow the call stack
      result.notNames += walk.notNames;
      result.untrusted ||= walk.untrusted;
    }
  } catch {
    return { found: [], notNames: 0, untrusted: true }; // the parser threw (for example a stack overflow on absurd nesting)
  }
  return result;
}

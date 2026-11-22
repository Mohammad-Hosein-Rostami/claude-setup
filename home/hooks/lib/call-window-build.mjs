// Builds the call windows of one session from the lines of its call-window log (lib/call-windows.mjs writes them), by the closing rules
// of spec-p1-gates-fix 2.2 with correction K4'. Split from call-windows.mjs to keep each file under 300 lines (C4).
// Exports: buildWindows(lines, {stopHookMs}) -> {windows, watches, folders}; parseLog(text) -> lines | null (one parser: P12).
// A window: {id, agent, tool, kind: 'program'|'path', path, bg, lim?, openAt, openB, closeAt, closeB, edge, missed?, stopHook?}.
//   closeAt Infinity means still open (an open window owns everything after its start); closeB null means "no size seen at the end";
//   `edge` is true only for a window closed by its own close or batch line (both edges in the log: the only kind another session's
//   claim may use).
// Invariants: pure; every doubt keeps a window open or adds one (a lost line, an unknown task type, a call inside a subagent).
const EDGE_SLACK_MS = 2000;
// task types the Stop input documents; any other value is a raw discriminant and closes no background window (K4' b). `workflow`
// stays although workflows are off (settings/base.json): it is a documented type and old logs still hold quiet lines listing it.
const KNOWN_TASK_TYPES = new Set(['shell', 'subagent', 'monitor', 'workflow', 'teammate', 'cloud session', 'MCP task']);
const KIND_OF_TOOL = { Bash: 'shell', PowerShell: 'shell', Monitor: 'monitor' };
const MISSED_KINDS = ['shell', 'monitor'];

function openWindow(line) {
  return {
    id: line.id, agent: line.agent, tool: line.tool, kind: line.path ? 'path' : 'program', path: line.path ?? null, bg: line.bg === true,
    lim: typeof line.lim === 'number' ? line.lim : undefined, openAt: line.at, openB: line.b, closeAt: Infinity, closeB: null, edge: false,
  };
}

const reopen = (window) => Object.assign(window, { bg: true, closeAt: Infinity, closeB: null, edge: false });

/** A close or batch line for `window`: the later of the two is its edge; a call that ran into its timeout became a background call. */
function closeAtEdge(window, line) {
  if (window.bg) return;
  if (window.lim !== undefined && line.at - window.openAt >= window.lim - EDGE_SLACK_MS) {
    reopen(window);
    return;
  }
  if (!window.edge || line.at >= window.closeAt) Object.assign(window, { closeAt: line.at, closeB: line.b, edge: true });
}

const holdsKind = (types, tool) => {
  const kind = KIND_OF_TOOL[tool];
  return kind === undefined ? types.length > 0 : types.includes(kind);
};

/** A quiet line closes its agent's open foreground calls, and the lead's background calls when no task of their kind is left. */
function closeAtQuiet(windows, quiet) {
  const onlyKnown = quiet.types.every((type) => KNOWN_TASK_TYPES.has(type));
  for (const window of windows) {
    if (window.closeAt !== Infinity || window.openAt > quiet.at) continue;
    const foreground = !window.bg && window.agent === quiet.agent;
    const background = window.bg && window.agent === '' && onlyKnown && !holdsKind(quiet.types, window.tool);
    if (foreground || background) Object.assign(window, { closeAt: quiet.at, closeB: quiet.b });
  }
}

/** A close with no open line: a program window from the log's first line to that close (a lost open). */
const missedClose = (line, first) => ({
  id: line.id, agent: line.agent ?? '', tool: '', kind: 'program', path: null, bg: false,
  openAt: first.at, openB: [], closeAt: line.at, closeB: line.b, edge: true, missed: 'close',
});

/** A quiet line naming a kind with no background window of that kind open: a lead window between the quiet lines without that kind. */
function missedQuietWindows(quiets, windows, first) {
  const added = [];
  for (const [index, quiet] of quiets.entries()) {
    for (const kind of MISSED_KINDS.filter((name) => quiet.types.includes(name))) {
      const seen = windows.some((w) => w.bg && KIND_OF_TOOL[w.tool] === kind && w.openAt <= quiet.at && quiet.at < w.closeAt);
      if (seen) continue;
      const before = quiets.slice(0, index).reverse().find((line) => !line.types.includes(kind)) ?? first;
      const after = quiets.slice(index + 1).find((line) => !line.types.includes(kind));
      added.push({
        id: null, agent: '', tool: '', kind: 'program', path: null, bg: false, openAt: before.at, openB: before.b ?? [],
        closeAt: after?.at ?? Infinity, closeB: after?.b ?? null, edge: false, missed: kind,
      });
    }
  }
  return added;
}

/** Each quiet line opens a window of its agent as long as the longest stop hook may run: a hook can write files then (K4' c). */
function stopHookWindows(lines, stopHookMs) {
  return lines.flatMap((line, index) => {
    if (line.t !== 'quiet') return [];
    const end = line.at + stopHookMs;
    const next = lines.slice(index + 1).find((later) => later.at > end);
    return [{
      id: null, agent: line.agent, tool: '', kind: 'program', path: null, bg: false, openAt: line.at, openB: line.b,
      closeAt: end, closeB: next?.b ?? null, edge: false, stopHook: true,
    }];
  });
}

/**
 * The windows of a parsed log, in line order, plus its watch lines.
 * @param {object[]} lines parseLog's result
 * @param {{stopHookMs: number}} hookTimes the longest Stop or SubagentStop hook timeout in ms
 * @returns {{windows: object[], watches: object[], folders: object[]}} watches: reflog watch lines; folders: worktree watch lines
 */
export function buildWindows(lines, { stopHookMs }) {
  const first = lines[0] ?? { at: 0, b: [] };
  const windows = [];
  const byId = new Map();
  const watches = [];
  const folders = [];
  for (const line of lines) {
    if (line.t === 'open') {
      const window = openWindow(line);
      windows.push(window);
      if (line.id !== null) byId.set(line.id, window);
    } else if (line.t === 'close') {
      const window = byId.get(line.id);
      if (window === undefined) windows.push(missedClose(line, first));
      else if (line.bg === true && !window.bg) reopen(window);
      else closeAtEdge(window, line);
    } else if (line.t === 'batch') {
      for (const id of line.ids) if (byId.has(id)) closeAtEdge(byId.get(id), line);
    } else if (line.t === 'quiet') {
      closeAtQuiet(windows, line);
    } else {
      (typeof line.top === 'string' ? folders : watches).push(line);
    }
  }
  const quiets = lines.filter((line) => line.t === 'quiet');
  return { windows: [...windows, ...missedQuietWindows(quiets, windows, first), ...stopHookWindows(lines, stopHookMs)], watches, folders };
}

/**
 * The parsed lines of a log text; null when a line is not JSON or not of a known shape (the log is then unusable).
 * @param {string} logText the log
 * @returns {object[] | null}
 */
export function parseLog(logText) {
  const lines = [];
  for (const raw of logText.split('\n')) {
    if (raw.trim() === '') continue;
    let line;
    try {
      line = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!knownShape(line)) return null;
    lines.push({ ...line, b: Array.isArray(line.b) ? line.b : [] });
  }
  return lines;
}

const isText = (value) => typeof value === 'string';
const SHAPES = {
  open: (line) => (line.id === null || isText(line.id)) && isText(line.agent) && isText(line.tool),
  close: (line) => isText(line.id),
  batch: (line) => Array.isArray(line.ids) && line.ids.every(isText),
  quiet: (line) => Array.isArray(line.types) && line.types.every(isText),
  watch: (line) => isText(line.top) || (Number.isInteger(line.k) && isText(line.reflog) && Number.isInteger(line.bytes) && isText(line.tip)),
};
const knownShape = (line) => line !== null && typeof line === 'object' && Object.hasOwn(SHAPES, line.t) && Number.isFinite(line.at) && SHAPES[line.t](line);

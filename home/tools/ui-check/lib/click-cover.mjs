// Purpose: explain a click that timed out: what is drawn on top of the target at its centre, and for a visually hidden input (a custom
// checkbox or radio) the hint to click its label. Exports: describeBlockedClick, clickFacts. Invariant: describeBlockedClick is pure (facts in, text out);
// clickFacts is serialised into the page, so it is self-contained.

/**
 * Runs inside the page on the step's target. Returns plain facts about the target and the element at its centre.
 * @param {Element} node the step's target
 * @returns {{target: {tag: string, id: string, type: string, hiddenVisually: boolean}, cover: null|{tag: string, id: string, className: string, coversTarget: boolean}}}
 */
export function clickFacts(node) {
  const r = node.getBoundingClientRect();
  const s = getComputedStyle(node);
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const cls = top && typeof top.className === 'string' ? top.className.trim() : '';
  return {
    target: { tag: node.tagName.toLowerCase(), id: node.id, type: node.getAttribute('type') ?? '', hiddenVisually: s.opacity === '0' || (s.clip !== 'auto' && s.clip !== '') || r.width <= 1 || r.height <= 1 },
    cover: top ? { tag: top.tagName.toLowerCase(), id: top.id, className: cls, coversTarget: top === node || node.contains(top) } : null,
  };
}

const describe = ({ tag, id, className }) => `<${tag}${id ? ` id="${id}"` : ''}${className ? ` class="${className}"` : ''}>`;

/**
 * One sentence (appended to the Playwright timeout message) saying why a pointer action could not reach the target.
 * @param {ReturnType<typeof clickFacts>} facts
 * @returns {string}
 */
export function describeBlockedClick({ target, cover }) {
  let why;
  if (cover === null) why = 'nothing is drawn at its centre (it may be off screen or have no size)';
  else if (cover.coversTarget) why = 'the target itself is on top at its centre (it may be disabled, detached or still moving)';
  else why = `covered at its centre by ${describe(cover)}`;
  const radioOrCheck = target.type === 'checkbox' || target.type === 'radio';
  const hint = target.tag === 'input' && (target.hiddenVisually || radioOrCheck) ? '; it is visually hidden, click its label instead (label[for="id"] or the wrapping label)' : '';
  return `${why}${hint}`;
}

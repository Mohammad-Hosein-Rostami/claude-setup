// Purpose: the pure page builder of `ui-proof review-page`: turns the review model into the HTML of index.html.
// Exports: renderPage(model), escapeHtml(text).
// Invariants: no file or network access; every text from the model is HTML-escaped; a live link is written only for an
//   http, https or file URL (anything else is shown as text); images are the relative hrefs the caller copied; the CSS is
//   inline (this tool ships no .css file); light and dark themes from prefers-color-scheme; tables stack below 48rem.

const NEW_TAB = '<span class="visually-hidden"> (opens in a new tab)</span>';
const LINKABLE = new Set(['http:', 'https:', 'file:']);
const IMAGE_LABELS = { baseline: 'Figma', actual: 'Actual', diff: 'Diff' };
const NONE = '<span class="muted">none</span>';

const CSS = `:root{color-scheme:light dark;--bg:#f6f7f9;--surface:#fff;--text:#1b1d21;--muted:#565b66;--border:#c4c8d0;
--link:#0a4fc4;--ok:#14602a;--bad:#9b1c1c;--space:1rem;--radius:.5rem}
@media (prefers-color-scheme:dark){:root{--bg:#101216;--surface:#1a1d23;--text:#e9ebef;--muted:#a9afbb;--border:#3b4150;
--link:#8db4ff;--ok:#7ddc98;--bad:#ff9b9b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:1rem/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{width:min(100% - 2rem,96rem);margin-inline:auto;padding-block:var(--space)}
a{color:var(--link);overflow-wrap:anywhere}
a:focus-visible{outline:3px solid var(--link);outline-offset:2px}
code{font:.875em ui-monospace,Menlo,Consolas,monospace;overflow-wrap:anywhere}
h1{font-size:clamp(1.5rem,4vw,2rem);margin:0 0 .25rem}
h2{font-size:1.375rem;margin:2rem 0 .5rem}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.skip{position:absolute;left:.5rem;top:-4rem;background:var(--surface);padding:.5rem 1rem}
.skip:focus{top:.5rem}
.muted{color:var(--muted)}
.ok{color:var(--ok);font-weight:600}
.bad{color:var(--bad);font-weight:600}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin:1rem 0}
.summary div{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem;min-width:0}
.summary dt{color:var(--muted);font-size:.875rem}
.summary dd{margin:0;font-size:1.25rem;font-weight:600}
table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border)}
caption{text-align:start;padding:.5rem 0;color:var(--muted)}
th,td{text-align:start;vertical-align:top;padding:.5rem .75rem;border-top:1px solid var(--border)}
thead th{border-top:0}
td ul{margin:0;padding-inline-start:1.25rem}
.thumbs{list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:.75rem}
.thumb{width:min(100%,15rem);font-size:.875rem;color:var(--muted)}
.thumb img{display:block;width:100%;height:auto;max-height:14rem;object-fit:contain;object-position:top;border:1px solid var(--border);background:#fff}
.missing{border:1px dashed var(--border);padding:1rem .5rem;overflow-wrap:anywhere}
@media (width < 48rem){thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
table,tbody,tr,td,th,caption{display:block}tr{border-top:2px solid var(--border);padding:.5rem 0}
td,th{border-top:0;padding:.25rem .75rem}
td[data-label]::before{content:attr(data-label);display:block;color:var(--muted);font-size:.8125rem;font-weight:600}}
@media (width >= 48rem){.thumb{width:10rem}td.imgs{min-width:33rem}}`;

/**
 * Escape text for HTML element content and double- or single-quoted attributes.
 * @param {unknown} text any value; null and undefined become an empty string
 * @returns {string} escaped text
 */
export function escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The URL when it may be a link target (http, https or file), else null.
function linkTarget(url) {
  if (typeof url !== 'string') return null;
  try {
    return LINKABLE.has(new URL(url).protocol) ? url : null;
  } catch (error) {
    if (error instanceof TypeError) return null; // not a URL at all: shown as text, never as a link
    throw error;
  }
}

function liveLink(url) {
  const target = linkTarget(url);
  if (target !== null) return `<a href="${escapeHtml(target)}" target="_blank" rel="noopener">Live page${NEW_TAB}</a><br><code>${escapeHtml(target)}</code>`;
  return url ? `<span class="muted">not a web URL:</span> <code>${escapeHtml(url)}</code>` : '<span class="muted">no URL recorded</span>';
}

function thumb(kind, label, image) {
  const caption = IMAGE_LABELS[kind];
  if (image.href === undefined) return `<li class="thumb"><div class="missing">${caption}: ${escapeHtml(image.missing)}</div></li>`;
  const size = image.width ? ` width="${image.width}" height="${image.height}"` : '';
  const img = `<img src="${escapeHtml(image.href)}" loading="lazy" alt="${caption} image for ${escapeHtml(label)}"${size}>`;
  return `<li class="thumb"><a href="${escapeHtml(image.href)}" target="_blank" rel="noopener">${img}${NEW_TAB}</a>${caption}</li>`;
}

function findingsList(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return '';
  const items = findings.map((f) => `<li><code>${escapeHtml(f?.check)}</code> <code>${escapeHtml(f?.element)}</code>: ${escapeHtml(f?.detail)}</li>`);
  return `<ul>${items.join('')}</ul>`;
}

function verdictLine(part, record) {
  const css = record.status === 'pass' ? 'ok' : 'bad';
  const width = Number.isFinite(record.width) ? ` at ${record.width} px` : '';
  const evidence = record.evidence ? `<br><span class="muted">evidence</span> <code>${escapeHtml(record.evidence)}</code>` : '';
  return `<p><span class="${css}">${part} ${escapeHtml(record.status)}</span>${width}${evidence}</p>${findingsList(record.findings)}`;
}

const rowLabel = (row) => `${row.surface} ${row.state} ${row.locale ?? '-'}`;

function imagesCell(row) {
  if (row.compares.length === 0) return '<span class="muted">no compare part: responsive only</span>';
  return row.compares
    .map((c) => `<ul class="thumbs" aria-label="Images for ${escapeHtml(rowLabel(row))} at ${escapeHtml(c.width)} px">${Object.keys(IMAGE_LABELS).map((kind) => thumb(kind, rowLabel(row), c.images[kind])).join('')}</ul>`)
    .join('');
}

function stateRow(row) {
  const verdict = [...row.compares.map((c) => verdictLine('compare', c)), ...row.responsive.map((r) => verdictLine('responsive', r))].join('');
  return `<tr>
<th scope="row" data-label="State"><code>${escapeHtml(row.surface)}</code> <code>${escapeHtml(row.state)}</code> <code>${escapeHtml(row.locale ?? '-')}</code></th>
<td data-label="Live">${liveLink(row.url)}</td>
<td class="imgs" data-label="Figma, actual, diff">${imagesCell(row)}</td>
<td data-label="Verdict">${verdict}</td>
</tr>`;
}

function table(id, caption, head, rows) {
  const headCells = head.map((h) => `<th scope="col">${h}</th>`).join('');
  return `<table aria-labelledby="h-${id}"><caption>${caption}</caption><thead><tr>${headCells}</tr></thead><tbody>${rows.join('\n')}</tbody></table>`;
}

/** Owner reference of a settled entry as one line of text. */
function ownerText(owner) {
  if (typeof owner === 'string') return owner;
  if (owner?.ask !== undefined) return `ask ${owner.ask}, answer "${owner.answer ?? ''}"`;
  if (owner?.status !== undefined) return `${owner.status} line "${owner.line ?? ''}"`;
  return owner === undefined ? 'no owner reference' : JSON.stringify(owner);
}

function coveredText(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return NONE;
  const items = findings.map((f) => (f?.check === 'pixel' ? `pixel up to ${escapeHtml(f.maxPercent)}%` : `${escapeHtml(f?.check)} <code>${escapeHtml(f?.element)}</code>`));
  return `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

function acceptedRow(entry) {
  const where = `<code>${escapeHtml(entry.surface)}</code> <code>${escapeHtml(entry.state)}</code> <code>${escapeHtml(entry.locale ?? '-')}</code>`;
  return `<tr><th scope="row" data-label="Frame">${escapeHtml(entry.node)}<br>${where}</th><td data-label="Accepted">${coveredText(entry.findings)}</td>
<td data-label="Reason">${entry.reason ? escapeHtml(entry.reason) : NONE}</td></tr>`;
}

function settledRow(entry) {
  return `<tr><th scope="row" data-label="State"><code>${escapeHtml(entry.surface)}</code> <code>${escapeHtml(entry.state)}</code> <code>${escapeHtml(entry.locale ?? 'all locales')}</code></th>
<td data-label="What">${escapeHtml(entry.what)}</td><td data-label="Owner">${escapeHtml(ownerText(entry.owner))}</td></tr>`;
}

function section(id, title, body) {
  return `<section aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${body}</section>`;
}

function statesSection(rows) {
  const caption = `${rows.length} rows, one per state and locale. Live pages need the app running; "View source" or DevTools on that tab shows the exact HTML.`;
  return section('states', 'States', table('states', caption, ['State', 'Live', 'Figma, actual, diff', 'Verdict'], rows.map(stateRow)));
}

function listSection(id, title, entries, { caption, head, render }) {
  return section(id, title, entries.length === 0 ? `<p class="muted">none</p>` : table(id, caption, head, entries.map(render)));
}

const rowPasses = (row) => [...row.compares, ...row.responsive].every((r) => r.status === 'pass');

/**
 * Build the whole review page.
 * @param {{generated: string, resultsDir: string, rows: object[], accepted: object[], settled: object[]}} model rows from
 *   the results records (each {surface, state, locale, url, compares: [{width, status, findings, evidence, images: {baseline,
 *   actual, diff: {href, width?, height?} | {missing}}}], responsive: [{width, status, findings, evidence}]}), the matrix
 *   `accepted` and `settled` entries
 * @returns {string} a complete HTML document
 */
export function renderPage(model) {
  const passing = model.rows.filter(rowPasses).length;
  const stat = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI review page</title>
<style>${CSS}</style>
</head>
<body>
<a class="skip" href="#main">Skip to results</a>
<header class="wrap">
<h1>UI review: Figma, actual, diff</h1>
<p class="muted">Generated ${escapeHtml(model.generated)} from <code>${escapeHtml(model.resultsDir)}</code>.</p>
<dl class="summary">${stat('Rows', model.rows.length)}${stat('Passing', passing)}${stat('Failing', model.rows.length - passing)}${stat('Accepted', model.accepted.length)}${stat('Settled', model.settled.length)}</dl>
</header>
<main id="main" class="wrap">
${statesSection(model.rows)}
${listSection('accepted', 'Accepted differences', model.accepted, { caption: 'Each accepted difference with its reason', head: ['Frame', 'Accepted', 'Reason'], render: acceptedRow })}
${listSection('settled', 'Settled, do not report again', model.settled, { caption: 'Points the owner has settled', head: ['State', 'What', 'Owner'], render: settledRow })}
</main>
</body>
</html>
`;
}

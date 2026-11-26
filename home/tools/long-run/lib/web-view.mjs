// Purpose: `long-run view`: a small web server on 127.0.0.1 that serves one page (web/) and the runs as JSON (runsData()), and
//   starts the default browser at it.
// Exports: VIEW_PORT_DEFAULT, startViewServer, openBrowser, viewCommand.
// Invariants: binds 127.0.0.1 only; answers GET and HEAD only (405 else); a Host header other than 127.0.0.1:<port> or
//   localhost:<port> gets 403, so a DNS-rebinding page cannot read the runs; the three page files are read once at start from a
//   fixed name map, so no URL path reaches the file system; no CORS header and a strict CSP on every answer; it writes nothing and
//   never touches a run's driver, lock or checkpoint database (runsData reads only).
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Refusal, UsageError, openRun } from './cli-common.mjs';
import { runsData } from './web-data.mjs';

/** The port `view` listens on without --port. */
export const VIEW_PORT_DEFAULT = 4790;
const LOOPBACK = '127.0.0.1';
const MAX_PORT = 65535;
const WEB_DIR = new URL('./web/', import.meta.url);
// URL path -> [file in web/, content type]. Only these paths serve a file.
const PAGE_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/view.js': ['view.js', 'text/javascript; charset=utf-8'],
  '/view.css': ['view.css', 'text/css; charset=utf-8'],
};
const RUNS_PATH = '/api/runs';
const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const READ_METHODS = new Set(['GET', 'HEAD']);
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
// The command that opens a URL in the default browser; any other platform uses xdg-open.
const BROWSER_COMMANDS = { darwin: 'open', win32: 'explorer.exe' };

function send(response, status, type, body) {
  response.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type });
  response.end(body); // Node sends no body for HEAD
}

/** One answer: the Host check first, then the method, then the fixed routes. */
function answer({ request, response, port, pages, root, now }) {
  const host = request.headers.host;
  if (host !== `${LOOPBACK}:${port}` && host !== `localhost:${port}`) return send(response, 403, TEXT_TYPE, 'forbidden host\n');
  if (!READ_METHODS.has(request.method)) return send(response, 405, TEXT_TYPE, 'only GET and HEAD\n');
  const path = request.url.split('?')[0];
  if (path === RUNS_PATH) {
    try {
      return send(response, 200, JSON_TYPE, JSON.stringify(runsData(root, { now: now() })));
    } catch (error) {
      // The page shows the error and polls again; the server keeps running.
      return send(response, 500, JSON_TYPE, JSON.stringify({ error: error.message }));
    }
  }
  const page = pages.get(path); // a Map: a path like `__proto__` finds nothing
  if (!page) return send(response, 404, TEXT_TYPE, 'not found\n');
  return send(response, 200, page.type, page.body);
}

/** The page files, read once (a URL path only picks a key of PAGE_FILES). */
function readPages() {
  return new Map(Object.entries(PAGE_FILES).map(([path, [file, type]]) => [path, { type, body: readFileSync(new URL(file, WEB_DIR)) }]));
}

/**
 * Starts the view server on 127.0.0.1.
 * @param {{root: string, port?: number, now?: () => Date}} options `root`: the state folder; `port`: 0 picks a free one.
 * @returns {Promise<{url: string, close: () => Promise<void>}>} `url`: `http://127.0.0.1:<port>/`; `close` ends open
 *   connections too (a browser keeps one open between polls).
 * @throws {Refusal} when the port is in use; any other listen error as it is.
 */
export function startViewServer({ root, port = VIEW_PORT_DEFAULT, now = () => new Date() }) {
  const pages = readPages();
  const server = createServer((request, response) => answer({ request, response, port: server.address().port, pages, root, now }));
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code !== 'EADDRINUSE') return reject(error);
      return reject(new Refusal(`port ${port} is in use (another long-run view? open http://${LOOPBACK}:${port}/); try --port <n>`));
    });
    server.listen({ host: LOOPBACK, port }, () => {
      const close = () => new Promise((done, fail) => {
        server.close((error) => (error ? fail(error) : done()));
        server.closeAllConnections();
      });
      resolve({ url: `http://${LOOPBACK}:${server.address().port}/`, close });
    });
  });
}

/**
 * Opens `url` in the default browser, detached; it never fails the view: the URL is printed already.
 * @param {string} url the page.
 * @param {{platform?: string, spawner?: typeof spawn}} options for tests.
 */
export function openBrowser(url, { platform = process.platform, spawner = spawn } = {}) {
  const child = spawner(BROWSER_COMMANDS[platform] ?? 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    // No opener on this machine (say xdg-open on a server): the printed URL opens the page by hand.
  });
  child.unref();
}

/** `--port`: a whole number from 0 to 65535, or VIEW_PORT_DEFAULT when not given. */
function portOf(value) {
  if (value === undefined) return VIEW_PORT_DEFAULT;
  if (!/^\d+$/.test(String(value)) || Number(value) > MAX_PORT) throw new UsageError('--port takes a whole number from 0 to 65535');
  return Number(value);
}

/**
 * `long-run view [<run>] [--port N] [--no-open]`: serves the screen until `signal` aborts (Ctrl-C), then closes the server.
 * @param {{positional: string[], flags: object, root: string, write: (line: string) => void, signal: AbortSignal}} context
 * @returns {Promise<void>} after the server closed.
 * @throws {UsageError} for a bad --port; {NotFound} for an unknown run; {Refusal} for a port in use.
 */
export async function viewCommand({ positional, flags, root, write, signal }) {
  const port = portOf(flags.port);
  const runId = positional[0] ? openRun(root, positional[0]).runId : null;
  const { url, close } = await startViewServer({ root, port });
  write(`long-run view at ${url} (Ctrl-C ends the view only; the runs go on)`);
  if (!flags['no-open']) openBrowser(runId ? `${url}#${runId}` : url);
  if (!signal.aborted) await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); });
  await close();
}

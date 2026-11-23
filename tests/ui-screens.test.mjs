// Tests for home/tools/ui-proof/lib/screens.mjs: screens inferred from a project at a commit (Next app/ and pages/, React Router
// objects and <Route>, Vue Router, Angular Routes, ui-coverage matrices, stories, e2e urls), the cache under the state dir, hostile
// text and bad input. Every repo is a throw-away cs-test git repo; git runs without the user's config; the cache dir is a temp dir.
// U8 probe: UI_SCREENS_PROBE=<repo> prints counts and timings only (no names), read-only git.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NO_VALUE, inferScreens, isComplete } from '../home/tools/ui-proof/lib/screens.mjs';
import { reachedScreens } from '../home/tools/ui-proof/lib/reach.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFiles(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return git(dir, 'rev-parse', 'HEAD');
}

function repoWith(files) {
  const dir = fs.realpathSync.native(makeTempDir('ui-screens-'));
  git(dir, 'init', '-q', '-b', 'main');
  return { dir, sha: commitFiles(dir, files) };
}

const stateDir = () => makeTempDir('ui-screens-state-');
const byRoute = (screens) => Object.fromEntries(screens.filter((s) => s.route !== null).map((s) => [s.route, s]));

const NEXT_APP = {
  'package.json': '{"name":"shop","dependencies":{"next":"15.0.0","react":"19.0.0"}}',
  'next.config.mjs': 'export default {};\n',
  'app/layout.tsx': 'export default function Layout({ children }) { return children; }\n',
  'app/page.tsx': 'export default function Home() { return <main>home</main>; }\n',
  'app/(shop)/items/[id]/page.tsx': 'export default function Item() { return <main>item</main>; }\n',
  'app/(shop)/items/[id]/layout.tsx': 'export default function ItemLayout({ children }) { return children; }\n',
  'app/_parts/hidden/page.tsx': 'export default function Hidden() { return null; }\n',
  'app/orders/[orderId]/page.tsx': 'export default function Order() { return null; }\n',
  'pages/about.tsx': 'export default function About() { return <p>about</p>; }\n',
  'pages/api/hello.ts': 'export default function handler() {}\n',
  'pages/_app.tsx': 'export default function App({ Component }) { return <Component />; }\n',
  'e2e/items.spec.ts': "import { test } from '@playwright/test';\ntest('item', async ({ page }) => { await page.goto('/items/42'); });\n",
};

test('Next app/ and pages/: routes, layouts, _app, route groups and private folders, an e2e value for a dynamic segment', () => {
  const { dir, sha } = repoWith(NEXT_APP);
  const { screens, unresolved } = inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() });
  const routes = byRoute(screens);
  assert.deepEqual(Object.keys(routes).sort(), ['/', '/about', '/items/[id]', '/orders/[orderId]']);
  assert.equal(routes['/'].source, 'next');
  assert.deepEqual(routes['/'].urls, ['/']);
  assert.deepEqual(routes['/items/[id]'].urls, ['/items/42']);
  assert.deepEqual(routes['/items/[id]'].wraps.sort(), ['app/(shop)/items/[id]/layout.tsx', 'app/layout.tsx']);
  assert.deepEqual(routes['/about'].wraps, ['pages/_app.tsx']);
  assert.deepEqual(unresolved, [`${NO_VALUE}"/orders/[orderId]" (app/orders/[orderId]/page.tsx, app/orders/[orderId]/page.tsx)`]);
  assert.equal(isComplete(unresolved), true);
});

test('React Router: createBrowserRouter objects (index, children, lazy) and nested <Route path> elements', () => {
  const { dir, sha } = repoWith({
    'package.json': '{"dependencies":{"react":"19.0.0","react-router-dom":"7.0.0"}}',
    'src/main.tsx': [
      "import { lazy } from 'react';",
      "import { createBrowserRouter } from 'react-router-dom';",
      "import Shell from './parts/Shell';",
      "import Home from './pages/Home';",
      "import { Member } from './pages/Member';",
      "const Settings = lazy(() => import('./pages/Settings'));",
      'export const router = createBrowserRouter([',
      "  { path: '/', element: <Shell />, children: [",
      '    { index: true, element: <Home /> },',
      "    { path: 'settings', element: <Settings /> },",
      "    { path: 'members/:memberId', element: <Member /> },",
      '  ] },',
      ']);',
    ].join('\n'),
    'src/App.tsx': [
      "import { BrowserRouter, Routes, Route } from 'react-router-dom';",
      "import PageA from './pages/PageA';",
      "import Frame from './parts/Frame';",
      "import PageC from './pages/PageC';",
      'export function App() {',
      '  return (<BrowserRouter><Routes>',
      '    <Route path="/a" element={<PageA />} />',
      '    <Route path="/b" element={<Frame />}>',
      '      <Route path="c" element={<PageC />} />',
      '    </Route>',
      '  </Routes></BrowserRouter>);',
      '}',
    ].join('\n'),
    ...Object.fromEntries(['Home', 'Settings', 'Member', 'PageA', 'PageC'].map((n) => [`src/pages/${n}.tsx`, `export function ${n}() { return null; }\nexport default ${n};\n`])),
    'src/parts/Shell.tsx': 'export default function Shell() { return null; }\n',
    'src/parts/Frame.tsx': 'export default function Frame() { return null; }\n',
  });
  const { screens, unresolved } = inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() });
  const routes = byRoute(screens);
  assert.equal(routes['/settings'].component, 'src/pages/Settings.tsx');
  assert.equal(routes['/settings'].source, 'react-router');
  const shell = ['src/App.tsx', 'src/main.tsx']; // the root router files are rendered around every route
  assert.deepEqual(routes['/settings'].wraps, ['src/parts/Shell.tsx', ...shell]);
  assert.equal(routes['/settings'].router, 'src/main.tsx');
  assert.equal(screens.find((s) => s.component === 'src/pages/Home.tsx').route, '/');
  assert.equal(routes['/a'].component, 'src/pages/PageA.tsx');
  assert.equal(routes['/b/c'].component, 'src/pages/PageC.tsx');
  assert.deepEqual(routes['/b/c'].wraps, ['src/parts/Frame.tsx', ...shell]);
  assert.deepEqual(routes['/members/:memberId'].urls, []);
  assert.deepEqual(unresolved, [`${NO_VALUE}"/members/:memberId" (src/pages/Member.tsx, src/main.tsx:11)`]);
});

test('Vue Router routes array: an imported view and a lazy view', () => {
  const { dir, sha } = repoWith({
    'package.json': '{"dependencies":{"vue":"3.5.0","vue-router":"4.4.0"}}',
    'src/router/index.ts': [
      "import { createRouter, createWebHistory } from 'vue-router';",
      "import HomeView from '../views/HomeView.vue';",
      "const routes = [{ path: '/', component: HomeView }, { path: '/about', component: () => import('../views/AboutView.vue') }];",
      'export default createRouter({ history: createWebHistory(), routes });',
    ].join('\n'),
    'src/views/HomeView.vue': '<template><p>home</p></template>\n',
    'src/views/AboutView.vue': '<template><p>about</p></template>\n',
  });
  const routes = byRoute(inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() }).screens);
  assert.equal(routes['/'].component, 'src/views/HomeView.vue');
  assert.equal(routes['/about'].component, 'src/views/AboutView.vue');
  assert.equal(routes['/about'].source, 'vue-router');
});

test('Angular Routes: provideRouter(routes) in another file, loadChildren with a prefix, loadComponent', () => {
  const { dir, sha } = repoWith({
    'package.json': '{"dependencies":{"@angular/core":"19.0.0","@angular/router":"19.0.0"}}',
    'src/app/app.config.ts': "import { provideRouter } from '@angular/router';\nimport { routes } from './app.routes';\nexport const appConfig = { providers: [provideRouter(routes)] };\n",
    'src/app/app.routes.ts': [
      "import { Routes } from '@angular/router';",
      "import { HomeComponent } from './home/home.component';",
      "export const routes: Routes = [{ path: '', component: HomeComponent }, { path: 'admin', loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES) }];",
    ].join('\n'),
    'src/app/admin/admin.routes.ts': "import { Routes } from '@angular/router';\nexport const ADMIN_ROUTES: Routes = [{ path: 'people', loadComponent: () => import('./people.component').then((m) => m.PeopleComponent) }];\n",
    'src/app/admin/people.component.ts': "@Component({ templateUrl: './people.component.html' })\nexport class PeopleComponent {}\n",
    'src/app/admin/people.component.html': '<p>people</p>\n',
    'src/app/home/home.component.ts': 'export class HomeComponent {}\n',
  });
  const routes = byRoute(inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() }).screens);
  assert.equal(routes['/'].component, 'src/app/home/home.component.ts');
  assert.equal(routes['/'].source, 'angular');
  assert.equal(routes['/admin/people'].component, 'src/app/admin/people.component.ts');
  assert.equal(routes['/people'], undefined, 'a linked routes file is read under its prefix only');
});

test('a ui-coverage matrix (mountedAt files, Figma frames) and a story file', () => {
  const matrix = { locales: [{ tag: 'en', dir: 'ltr' }], widths: [320], root: '..', surfaces: [{ id: 'card', kind: 'screen', source: 'x',
    controls: [{ id: 'save', class: 'button', component: 'src/Button.tsx', mountedAt: 'src/Card.tsx:2', states: [] }] }], cells: [],
  frames: [{ node: '12:40', name: 'Card', width: 320, cells: [{ surface: 'card', state: 'rest', locale: 'en' }] }] };
  const { dir, sha } = repoWith({
    'ui/screen-matrix.json': JSON.stringify(matrix),
    'src/Card.tsx': "import { Button } from './Button';\nexport const Card = () => <Button />;\n",
    'src/Button.tsx': 'export const Button = () => <button>save</button>;\n',
    'src/Button.stories.tsx': "import { Button } from './Button';\nexport default { title: 'Parts/Button', component: Button };\nexport const Primary = {};\nexport const WithIcon = {};\n",
  });
  const { screens } = inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() });
  const card = screens.find((s) => s.id === 'matrix:card');
  assert.deepEqual({ component: card.component, frames: card.frames, source: card.source }, { component: 'src/Card.tsx', frames: ['12:40'], source: 'matrix' });
  const story = screens.find((s) => s.source === 'story');
  assert.equal(story.component, 'src/Button.stories.tsx');
  assert.deepEqual(story.urls, ['/iframe.html?id=parts-button--primary', '/iframe.html?id=parts-button--with-icon']);
});

test('Playwright page.goto paths: a const, a ${base} template, a local host and the baseURL path; foreign hosts are left out', () => {
  const { dir, sha } = repoWith({
    'e2e/playwright.config.ts': "export default { use: { baseURL: process.env.BASE ?? 'http://localhost:4200/portal/' } };\n",
    'e2e/tests/board.spec.ts': [
      "const BOARD = '/portal/board?view=week';",
      "test('a', async ({ page }) => { await page.goto(BOARD); await page.goto(`${BASE_URL}sign-in`); });",
      "test('b', async ({ page }) => { await page.goto('http://localhost:4200/portal/board'); await page.goto('https://example.com/x'); });",
    ].join('\n'),
  });
  const { screens, unresolved } = inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() });
  assert.deepEqual(screens.map((s) => [s.id, s.urls]), [['e2e:/portal/board', ['/portal/board?view=week', '/portal/board']], ['e2e:/portal/sign-in', ['/portal/sign-in']]]);
  assert.equal(screens[0].component, 'e2e/tests/board.spec.ts');
  assert.deepEqual(unresolved, [`unmatched: the e2e url "/portal/board" fits no inferred route`, `unmatched: the e2e url "/portal/sign-in" fits no inferred route`]);
  assert.equal(isComplete(unresolved), false);
});

test('cache: the second call hits it, a changed router file misses it, nothing is written inside the repo', () => {
  const { dir, sha } = repoWith(NEXT_APP);
  const cacheDir = stateDir();
  assert.equal(inferScreens({ repoDir: dir, rev: sha, stateDir: cacheDir }).cached, false);
  const again = inferScreens({ repoDir: dir, rev: sha, stateDir: cacheDir });
  assert.equal(again.cached, true);
  assert.ok(byRoute(again.screens)['/about']);
  const files = fs.readdirSync(cacheDir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^[A-Za-z0-9_.-]+-[0-9a-f]{16}\.json$/);
  const next = commitFiles(dir, { 'e2e/items.spec.ts': "test('item', async ({ page }) => { await page.goto('/items/7'); });\n" });
  const changed = inferScreens({ repoDir: dir, rev: next, stateDir: cacheDir });
  assert.equal(changed.cached, false);
  assert.deepEqual(byRoute(changed.screens)['/items/[id]'].urls, ['/items/7']);
  assert.equal(inferScreens({ repoDir: dir, rev: sha, stateDir: cacheDir }).cached, true, 'the older commit keeps its entry');
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('cache: a changed router file, and a changed file a router links, miss it', () => {
  const { dir, sha } = repoWith({
    'src/main.tsx': "import { createBrowserRouter } from 'react-router-dom';\nimport { routes } from './table';\nexport const router = createBrowserRouter(routes);\n",
    'src/table.ts': "import Home from './Home';\nexport const routes = [{ path: '/', element: <Home /> }];\n",
    'src/Home.tsx': 'export default function Home() { return null; }\n',
  });
  const cacheDir = stateDir();
  assert.deepEqual(inferScreens({ repoDir: dir, rev: sha, stateDir: cacheDir }).screens.map((s) => s.route), ['/']);
  assert.equal(inferScreens({ repoDir: dir, rev: sha, stateDir: cacheDir }).cached, true);
  const linked = commitFiles(dir, { 'src/table.ts': "import Home from './Home';\nexport const routes = [{ path: '/start', element: <Home /> }];\n" });
  const second = inferScreens({ repoDir: dir, rev: linked, stateDir: cacheDir });
  assert.deepEqual([second.cached, second.screens.map((s) => s.route)], [false, ['/start']]);
  const router = commitFiles(dir, { 'src/main.tsx': "import { createHashRouter } from 'react-router-dom';\nimport { routes } from './table';\nexport const router = createHashRouter(routes);\n" });
  assert.equal(inferScreens({ repoDir: dir, rev: router, stateDir: cacheDir }).cached, false);
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('cache: a corrupt or foreign cache file is ignored and rewritten; UI_SCREENS_STATE_DIR is the default folder', () => {
  const { dir, sha } = repoWith(NEXT_APP);
  const cacheDir = stateDir();
  const saved = process.env.UI_SCREENS_STATE_DIR;
  process.env.UI_SCREENS_STATE_DIR = cacheDir;
  try {
    assert.equal(inferScreens({ repoDir: dir, rev: sha }).cached, false);
    const [name] = fs.readdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, name), '{ torn');
    assert.equal(inferScreens({ repoDir: dir, rev: sha }).cached, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')).format, 'ui-screens/2');
    fs.writeFileSync(path.join(cacheDir, name), JSON.stringify({ format: 'ui-screens/2', commonDir: '/elsewhere/.git', entries: [] }));
    assert.equal(inferScreens({ repoDir: dir, rev: sha }).cached, false);
    assert.equal(inferScreens({ repoDir: dir, rev: sha }).cached, true);
  } finally {
    if (saved === undefined) delete process.env.UI_SCREENS_STATE_DIR; else process.env.UI_SCREENS_STATE_DIR = saved;
  }
});

test('hostile text: a quoted route path, 10k routes and a 5 MB router file are capped, quoted and never evaluated', () => {
  const many = Array.from({ length: 10_000 }, (_, i) => `  <Route path="/r${i}" element={<Page />} />`).join('\n');
  const { dir, sha } = repoWith({
    'src/Many.tsx': `import { BrowserRouter, Route } from 'react-router-dom';\nimport Page from './Page';\nexport const A = () => <BrowserRouter>\n${many}\n</BrowserRouter>;\n`,
    'src/Page.tsx': 'export default function Page() { return null; }\n',
    'src/Big.tsx': `import { createBrowserRouter } from 'react-router-dom';\n${'// filler\n'.repeat(550_000)}`,
  });
  const { screens, unresolved } = inferScreens({ repoDir: dir, rev: sha, stateDir: stateDir() });
  assert.equal(screens.length, 3000);
  assert.deepEqual(unresolved, ['unread: src/Big.tsx is over 1048576 bytes', 'capped: 10000 screens, the first 3000 kept']);
  assert.equal(isComplete(unresolved), false);
  const quoted = repoWith({
    'src/Quoted.tsx': `import { BrowserRouter, Route } from 'react-router-dom';\nimport Page from './Page';\nexport const B = () => <BrowserRouter><Route path={'/it\\'s "x"\`; process.exit(1)'} element={<Page />} /></BrowserRouter>;\n`,
    'src/Page.tsx': 'export default function Page() { return null; }\n',
  });
  const one = inferScreens({ repoDir: quoted.dir, rev: quoted.sha, stateDir: stateDir() });
  assert.deepEqual(one.screens.map((s) => [s.route, s.urls]), [['/it\'s "x"`; process.exit(1)', ['/it\'s "x"`; process.exit(1)']]]);
});

test('a bad or unknown rev and a folder that is no repo give one unread line, never a throw', () => {
  const { dir } = repoWith(NEXT_APP);
  for (const rev of ['--output=x', 'no-such-branch']) {
    const result = inferScreens({ repoDir: dir, rev, stateDir: stateDir() });
    assert.deepEqual([result.screens.length, result.unresolved.length, result.unresolved[0].startsWith('unread: ')], [0, 1, true]);
  }
  assert.equal(inferScreens({ repoDir: makeTempDir('ui-screens-plain-'), rev: 'HEAD', stateDir: stateDir() }).unresolved.length, 1);
});

test('U8 probe on a real repo (UI_SCREENS_PROBE): counts and timings only, read-only git', { skip: !process.env.UI_SCREENS_PROBE && 'UI_SCREENS_PROBE not set' }, () => {
  const repoDir = process.env.UI_SCREENS_PROBE;
  const cacheDir = stateDir();
  const time = (run) => { const start = process.hrtime.bigint(); const value = run(); return { value, ms: Number((process.hrtime.bigint() - start) / 1_000_000n) }; };
  const first = time(() => inferScreens({ repoDir, rev: 'HEAD', stateDir: cacheDir }));
  const second = time(() => inferScreens({ repoDir, rev: 'HEAD', stateDir: cacheDir }));
  const { screens, unresolved } = first.value;
  const count = (test) => screens.filter(test).length;
  const sources = [...new Set(screens.map((s) => s.source))].map((source) => `${source} ${count((s) => s.source === source)}`).join(', ');
  const kinds = [...new Set(unresolved.map((line) => line.split(':')[0]))].map((kind) => `${kind} ${unresolved.filter((l) => l.startsWith(`${kind}:`)).length}`).join(', ');
  console.log(`U8 screens ${screens.length} (${sources}); literal routes ${count((s) => s.route !== null && s.source !== 'e2e')}; with urls ${count((s) => s.urls.length > 0)}`);
  console.log(`U8 unresolved ${unresolved.length} (${kinds || 'none'}); complete ${isComplete(unresolved)}`);
  console.log(`U8 first run ${first.ms} ms (cached ${first.value.cached}); second run ${second.ms} ms (cached ${second.value.cached})`);
  const samples = [...new Set(screens.filter((s) => s.source !== 'e2e' && s.source !== 'story').map((s) => s.component))].slice(0, 10);
  const reaches = samples.map((file) => time(() => reachedScreens({ repoDir, revs: ['HEAD'], files: [file], screens })));
  if (reaches.length > 0) {
    const reached = reaches.map((r) => r.value.reached.length).sort((a, b) => a - b);
    console.log(`U8 reach of ${reaches.length} one-file changes: all ${reaches.filter((r) => r.value.all).length}; screens reached median ${reached[Math.floor(reached.length / 2)]}, max ${reached.at(-1)}; slowest ${Math.max(...reaches.map((r) => r.ms))} ms`);
  }
  assert.equal(second.value.cached, true);
});

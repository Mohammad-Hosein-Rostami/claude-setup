// Tests for home/tools/ui-proof/lib/reach.mjs: which inferred screens a change reaches by a full import walk (no hop cap, cycles,
// tsconfig paths, Vite aliases, workspace packages, lazy and template imports), at base and tip, and the safe `all: true` fallbacks
// with one reason line (missing import, non-literal import, undeclared package, a file no screen imports, a project with no known
// router). Every repo is a throw-away cs-test git repo; git runs without the user's config; the screens cache is a temp dir.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { reachedScreens } from '../home/tools/ui-proof/lib/reach.mjs';
import { inferScreens } from '../home/tools/ui-proof/lib/screens.mjs';
import { makeTempDir } from './temp-dir-helpers.mjs';

const GIT_ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};
const WHY = /^reach unresolved: [^\n]+: rendering every inferred route$/;

function git(dir, args, input) {
  const result = spawnSync('git', args, { cwd: dir, env: GIT_ENV, encoding: 'utf8', input, maxBuffer: 64 << 20 });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function commitFiles(dir, files, removed = []) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  for (const file of removed) fs.rmSync(path.join(dir, file));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return git(dir, ['rev-parse', 'HEAD']);
}

function repoWith(files) {
  const dir = fs.realpathSync.native(makeTempDir('ui-reach-'));
  git(dir, ['init', '-q', '-b', 'main']);
  return { dir, sha: commitFiles(dir, files) };
}

const page = (name, imports = []) => `${imports.map((spec, i) => `import part${i} from '${spec}';`).join('\n')}\nexport default function ${name}() { return null; }\n`;
const chain = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`src/deep/level${n}.ts`, page(`Level${n}`, [n < 5 ? `./level${n + 1}` : '../ui/button', ...(n === 3 ? ['./level1'] : [])])]));

const APP = {
  'package.json': '{"name":"app","dependencies":{"react":"19.0.0","react-router-dom":"7.0.0"}}',
  'tsconfig.json': '{\n  // comments and trailing commas are allowed\n  "compilerOptions": { "baseUrl": ".", "paths": { "@shared/*": ["src/shared/*"], }, },\n}\n',
  'src/main.tsx': [
    "import { createBrowserRouter } from 'react-router-dom';",
    "import PageA from './pages/PageA';",
    "import PageB from './pages/PageB';",
    "export const router = createBrowserRouter([{ path: '/a', element: <PageA /> }, { path: '/b', element: <PageB /> }]);",
  ].join('\n'),
  'src/pages/PageA.tsx': page('PageA', ['../deep/level1']),
  'src/pages/PageB.tsx': `import { x } from '@shared/x';\nimport { lazy } from 'react';\nconst Panel = lazy(() => import('./Panel'));\nconst t = (lang) => import(\`./locales/\${lang}.json\`);\nexport default function PageB() { return null; }\n`,
  'src/pages/Panel.tsx': page('Panel'),
  'src/pages/locales/en.json': '{}\n',
  'src/shared/x.ts': 'export const x = 1;\n',
  'src/ui/button.tsx': 'export default function Button() { return <button />; }\n',
  'src/pages/PageA.test.tsx': "import PageA from './PageA';\n",
  ...chain,
};

const reach = (dir, revs, files) => {
  const { screens } = inferScreens({ repoDir: dir, rev: revs.at(-1), stateDir: makeTempDir('ui-reach-state-') });
  return reachedScreens({ repoDir: dir, revs, files, screens });
};

test('button.tsx 6 imports below route A reaches A, not B (no hop cap; the import cycle ends)', () => {
  const { dir, sha } = repoWith(APP);
  assert.deepEqual(reach(dir, [sha], ['src/ui/button.tsx']), { reached: [{ id: 'react-router:/a', via: 'src/ui/button.tsx' }], all: false, why: null });
});

test('the tsconfig alias @shared/x, a lazy import() and a template-literal import resolve to edges', () => {
  const { dir, sha } = repoWith(APP);
  for (const file of ['src/shared/x.ts', 'src/pages/Panel.tsx', 'src/pages/locales/en.json']) {
    assert.deepEqual(reach(dir, [sha], [file]), { reached: [{ id: 'react-router:/b', via: file }], all: false, why: null }, file);
  }
});

test('an unresolvable ./missing import gives all: true with one reason line', () => {
  const { dir, sha } = repoWith({ ...APP, 'src/pages/PageB.tsx': "import gone from './missing';\nexport default function PageB() { return null; }\n" });
  const result = reach(dir, [sha], ['src/ui/button.tsx']);
  assert.equal(result.all, true);
  assert.match(result.why, WHY);
  assert.match(result.why, /"\.\/missing" in src\/pages\/PageB\.tsx names no file/);
  assert.deepEqual(result.reached, [{ id: 'react-router:/a', via: 'src/ui/button.tsx' }]);
});

test('a deleted file is reached at base', () => {
  const { dir, sha: base } = repoWith({ ...APP, 'src/pages/PageA.tsx': page('PageA', ['../deep/level1', './old']), 'src/pages/old.ts': 'export default 1;\n' });
  const tip = commitFiles(dir, { 'src/pages/PageA.tsx': page('PageA', ['../deep/level1']) }, ['src/pages/old.ts']);
  assert.deepEqual(reach(dir, [base, tip], ['src/pages/old.ts']), { reached: [{ id: 'react-router:/a', via: 'src/pages/old.ts' }], all: false, why: null });
  assert.equal(reach(dir, [tip], ['src/pages/old.ts']).all, true, 'at the tip alone nothing imports it');
});

test('a non-literal import, an undeclared bare import and a file no screen imports each give all with one line; a test file does not', () => {
  const { dir, sha } = repoWith({ ...APP, 'src/pages/Panel.tsx': "const load = (name) => import(name);\nexport default function Panel() { return null; }\n" });
  const dynamic = reach(dir, [sha], ['src/ui/button.tsx']);
  assert.match(dynamic.why, /^reach unresolved: src\/pages\/Panel\.tsx imports a non-literal module \("name"\) \(at [0-9a-f]{12}\): rendering every inferred route$/);
  const undeclared = repoWith({ ...APP, 'src/shared/x.ts': "import lib from 'components/lib';\nexport const x = 1;\n" });
  assert.match(reach(undeclared.dir, [undeclared.sha], ['src/ui/button.tsx']).why, /"components\/lib" in src\/shared\/x\.ts is no file, alias or declared package/);
  const remote = repoWith({ ...APP, 'src/pages/Panel.tsx': "const sdk = (origin) => import(`${origin}/sdk.mjs`);\nexport default function Panel() { return null; }\n" });
  assert.equal(reach(remote.dir, [remote.sha], ['src/ui/button.tsx']).all, false, 'a url built at run time is no repo module');
  const clean = repoWith({ ...APP, 'src/unused.ts': 'export const unused = 1;\n' });
  assert.equal(reach(clean.dir, [clean.sha], ['src/pages/PageA.test.tsx']).all, false);
  assert.equal(reach(clean.dir, [clean.sha], ['src\\deep\\level5.ts']).reached[0].id, 'react-router:/a', 'a Windows path is read as a repo path');
  const unused = reach(clean.dir, [clean.sha], ['src/unused.ts']);
  assert.deepEqual([unused.all, unused.why], [true, 'reach unresolved: src/unused.ts is imported by no inferred screen: rendering every inferred route']);
});

test('a Vite alias, a workspace package and a Next layout reach their screens', () => {
  const { dir, sha } = repoWith({
    'package.json': '{"name":"site","dependencies":{"next":"15.0.0","@acme/kit":"workspace:*"}}',
    'next.config.mjs': 'export default {};\n',
    'vite.config.ts': "import path from 'node:path';\nexport default { resolve: { alias: { '@': path.resolve(__dirname, './src') } } };\n",
    'app/layout.tsx': "import Nav from '@/nav';\nexport default function Layout({ children }) { return children; }\n",
    'app/page.tsx': "import { Card } from '@acme/kit';\nexport default function Home() { return <Card />; }\n",
    'app/about/page.tsx': 'export default function About() { return null; }\n',
    'src/nav.tsx': 'export default function Nav() { return null; }\n',
    'packages/kit/package.json': '{"name":"@acme/kit","main":"src/index.ts"}',
    'packages/kit/src/index.ts': "export { Card } from './Card';\n",
    'packages/kit/src/Card.tsx': 'export const Card = () => null;\n',
  });
  assert.deepEqual(reach(dir, [sha], ['packages/kit/src/Card.tsx']).reached, [{ id: 'next:/', via: 'packages/kit/src/Card.tsx' }]);
  assert.deepEqual(reach(dir, [sha], ['src/nav.tsx']).reached.map((r) => r.id), ['next:/', 'next:/about']);
});

test('a project with no known router falls back to every inferred route with one reason line', () => {
  const { dir, sha } = repoWith({
    'package.json': '{"name":"custom","dependencies":{"tiny-router":"1.0.0"}}',
    'src/start.ts': "import { mount } from 'tiny-router';\nimport Dash from './Dash';\nmount({ '/dash': Dash });\n",
    'src/Dash.tsx': 'export default function Dash() { return null; }\n',
    'e2e/dash.spec.ts': "test('dash', async ({ page }) => { await page.goto('/dash'); });\n",
  });
  const { screens } = inferScreens({ repoDir: dir, rev: sha, stateDir: makeTempDir('ui-reach-state-') });
  assert.deepEqual(screens.map((s) => [s.id, s.urls]), [['e2e:/dash', ['/dash']]]);
  const result = reachedScreens({ repoDir: dir, revs: [sha], files: ['src/Dash.tsx'], screens });
  assert.deepEqual(result, { reached: [], all: true, why: 'reach unresolved: src/Dash.tsx is imported by no inferred screen: rendering every inferred route' });
  const none = reachedScreens({ repoDir: dir, revs: [sha], files: ['src/Dash.tsx'], screens: [] });
  assert.match(none.why, /^reach unresolved: no inferred screen \(and 1 more\): rendering every inferred route$/);
});

test('a 100k-file tree: inference and reach answer from git objects (time logged, not asserted)', () => {
  const { dir } = repoWith(APP);
  const blob = git(dir, ['hash-object', '-w', '--stdin'], 'export const filler = 1;\n');
  const lines = Array.from({ length: 100_000 }, (_, i) => `100644 ${blob}\tvendor/part${i % 100}/file${i}.ts`).join('\n');
  git(dir, ['update-index', '--index-info'], `${lines}\n`);
  const tip = git(dir, ['commit-tree', git(dir, ['write-tree']), '-p', 'HEAD', '-m', 'big'], '');
  const start = Date.now();
  const result = reach(dir, [tip], ['src/ui/button.tsx']);
  console.log(`100k-file tree: inference and reach took ${Date.now() - start} ms`);
  assert.deepEqual(result, { reached: [{ id: 'react-router:/a', via: 'src/ui/button.tsx' }], all: false, why: null });
});

const ROUTER_PKG = '{"name":"app","dependencies":{"react":"19.0.0","react-dom":"19.0.0","react-router-dom":"7.0.0","vue":"3.5.0","vue-router":"4.4.0","@angular/core":"19.0.0","@angular/router":"19.0.0","@angular/platform-browser":"19.0.0"}}';
const routerOf = (routes, imports) => `import { createBrowserRouter } from 'react-router-dom';\n${imports}\nexport const router = createBrowserRouter([${routes}]);\n`;
const AB = "{ path: '/a', element: <A /> }, { path: '/b', element: <B /> }";

test('the app shell: a util of a file rendered around every route reaches every route (React, Vue, Angular)', () => {
  const shared = { 'src/fmt.ts': 'export default 1;\n', 'src/onlyB.ts': 'export default 2;\n' };
  const apps = {
    'a header beside <Routes>': { 'src/App.tsx': "import { BrowserRouter, Routes, Route } from 'react-router-dom';\nimport Header from './Header';\nimport A from './A';\nimport B from './B';\nexport default function App() { return <BrowserRouter><Header /><Routes><Route path=\"/a\" element={<A />} /><Route path=\"/b\" element={<B />} /></Routes></BrowserRouter>; }\n",
      'src/Header.tsx': page('Header', ['./fmt']), 'src/A.tsx': page('A', ['./fmt']), 'src/B.tsx': page('B', ['./onlyB']) },
    'providers around RouterProvider': { 'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport { RouterProvider } from 'react-router-dom';\nimport { router } from './router';\nimport Providers from './Providers';\ncreateRoot(document.body).render(<Providers><RouterProvider router={router} /></Providers>);\n",
      'src/router.tsx': routerOf(AB, "import A from './A';\nimport B from './B';"), 'src/Providers.tsx': page('Providers', ['./fmt']), 'src/A.tsx': page('A', ['./fmt']), 'src/B.tsx': page('B', ['./onlyB']) },
    'Vue App.vue with <router-view>': { 'src/main.ts': "import { createApp } from 'vue';\nimport App from './App.vue';\nimport router from './router';\ncreateApp(App).use(router).mount('#app');\n",
      'src/router.ts': "import { createRouter } from 'vue-router';\nimport A from './A.vue';\nimport B from './B.vue';\nexport default createRouter({ routes: [{ path: '/a', component: A }, { path: '/b', component: B }] });\n",
      'src/App.vue': "<template><AppHeader /><router-view /></template>\n<script setup>\nimport AppHeader from './AppHeader.vue';\n</script>\n",
      'src/AppHeader.vue': "<script setup>\nimport fmt from './fmt';\n</script>\n", 'src/A.vue': "<script setup>\nimport fmt from './fmt';\n</script>\n", 'src/B.vue': "<script setup>\nimport b from './onlyB';\n</script>\n" },
    'an Angular AppComponent with <router-outlet>': { 'src/main.ts': "import { bootstrapApplication } from '@angular/platform-browser';\nimport { AppComponent } from './app.component';\nimport { appConfig } from './app.config';\nbootstrapApplication(AppComponent, appConfig);\n",
      'src/app.config.ts': "import { provideRouter } from '@angular/router';\nimport { routes } from './app.routes';\nexport const appConfig = { providers: [provideRouter(routes)] };\n",
      'src/app.routes.ts': "import { Routes } from '@angular/router';\nimport { AComponent } from './a.component';\nimport { BComponent } from './b.component';\nexport const routes: Routes = [{ path: 'a', component: AComponent }, { path: 'b', component: BComponent }];\n",
      'src/app.component.ts': "import { RouterOutlet } from '@angular/router';\nimport { HeaderComponent } from './header.component';\n@Component({ imports: [RouterOutlet, HeaderComponent], template: '<app-header /><router-outlet />' })\nexport class AppComponent {}\n",
      'src/header.component.ts': "import fmt from './fmt';\nexport class HeaderComponent {}\n", 'src/a.component.ts': "import fmt from './fmt';\nexport class AComponent {}\n", 'src/b.component.ts': "import b from './onlyB';\nexport class BComponent {}\n" },
  };
  for (const [name, files] of Object.entries(apps)) {
    const { dir, sha } = repoWith({ 'package.json': ROUTER_PKG, ...shared, ...files });
    const routesOf = (file) => { const r = reach(dir, [sha], [file]); return r.all ? r.why : r.reached.map((x) => x.id.split(':')[1]).join(','); };
    assert.equal(routesOf('src/fmt.ts'), '/a,/b', name);
    assert.equal(routesOf('src/onlyB.ts'), '/b', `${name}: a util of one route only stays on it`);
  }
});

test('a plain stylesheet, a CSS module with :global and a Vue <style> without scoped reach every screen; a CSS module stays scoped', () => {
  const { dir, sha } = repoWith({
    'package.json': ROUTER_PKG,
    'src/main.tsx': routerOf(AB, "import A from './A';\nimport B from './B';"),
    'src/A.tsx': page('A', ['./a.css', './a.module.css', './g.module.scss', './Panel.vue', './Card.vue']), 'src/B.tsx': page('B'),
    'src/a.css': 'h1 { color: red; }\n', 'src/a.module.css': '.title { color: red; }\n', 'src/g.module.scss': ':global(body) { margin: 0; }\n',
    'src/Panel.vue': '<template><p/></template>\n<style lang="scss">\np { color: red; }\n</style>\n',
    'src/Card.vue': '<template><p/></template>\n<style scoped>\np { color: red; }\n</style>\n',
  });
  const ids = (file) => reach(dir, [sha], [file]).reached.map((r) => r.id);
  for (const file of ['src/a.css', 'src/g.module.scss', 'src/Panel.vue']) assert.deepEqual(ids(file), ['react-router:/a', 'react-router:/b'], file);
  for (const file of ['src/a.module.css', 'src/Card.vue']) assert.deepEqual(ids(file), ['react-router:/a'], file);
});

test('a route component behind an alias the resolver does not read keeps its screen and gives all with one line', () => {
  const { dir, sha } = repoWith({
    'package.json': ROUTER_PKG,
    'src/main.tsx': routerOf(AB, "import A from './A';\nimport B from 'pages/B';"),
    'src/A.tsx': page('A', ['./pages/B']), 'src/pages/B.tsx': page('B'),
  });
  const { screens, unresolved } = inferScreens({ repoDir: dir, rev: sha, stateDir: makeTempDir('ui-reach-state-') });
  assert.deepEqual(screens.map((s) => [s.route, s.component]), [['/a', 'src/A.tsx'], ['/b', 'src/main.tsx']]);
  assert.deepEqual(unresolved, ['unresolved: "pages/B" in src/main.tsx is no file, alias or declared package (the route at src/main.tsx:4)']);
  const result = reachedScreens({ repoDir: dir, revs: [sha], files: ['src/pages/B.tsx'], screens });
  assert.equal(result.all, true);
  assert.match(result.why, /^reach unresolved: "pages\/B" in src\/main\.tsx is no file, alias or declared package \(at [0-9a-f]{12}\): rendering/);
});

test('the walk bound: a walk past its file cap or its time budget gives all with one line', () => {
  const { dir, sha } = repoWith(APP);
  const { screens } = inferScreens({ repoDir: dir, rev: sha, stateDir: makeTempDir('ui-reach-state-') });
  for (const bound of [{ maxWalkFiles: 3 }, { budgetMs: -1 }]) {
    const result = reachedScreens({ repoDir: dir, revs: [sha], files: ['src/ui/button.tsx'], screens, ...bound });
    assert.equal(result.all, true, JSON.stringify(bound));
    assert.match(result.why, /^reach unresolved: the walk passed \d+ files or its time budget \(at [0-9a-f]{12}\)/);
  }
});

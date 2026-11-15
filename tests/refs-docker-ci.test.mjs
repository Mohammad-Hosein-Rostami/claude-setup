// Tests for the compose, Dockerfile, CI workflow and CODEOWNERS readers of home/tools/refs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findingLines, project, refs } from './refs-helpers.mjs';

const COMPOSE = [
  'services:', '  web:', '    build:', '      context: ./app', '      dockerfile: Dockerfile.dev', '    env_file:', '      - .env', '      - ./web.env',
  '    volumes:', '      - ./src:/app/src', '      - data:/var/lib', '      - ../refs-sibling-gone:/shared:ro', '  api:', '    build: ./api', '    env_file: api.env',
  '    volumes:', '      - "./conf:/etc/conf"', 'volumes:', '  data:', '',
].join('\n');

test('compose-path: build context, dockerfile, env_file entries and bind mounts; present paths give nothing', () => {
  const root = project({ 'docker-compose.yml': COMPOSE, 'app/Dockerfile.dev': '', '.env': 'A=1\n', 'src/x': '', 'api/x': '', 'api.env': '' });
  assert.deepEqual(findingLines(refs(root)), [
    'docker-compose.yml:8 compose-path ./web.env -> missing',
    'docker-compose.yml:12 compose-path ../refs-sibling-gone -> missing',
    'docker-compose.yml:17 compose-path ./conf -> missing',
  ]);
});

test('compose-path: a missing context, a missing dockerfile and a missing short-form build', () => {
  const root = project({ 'compose.yaml': COMPOSE.replaceAll('./web.env', '.env'), 'app/other': '', '.env': '', 'src/a': '' });
  const lines = findingLines(refs(root));
  assert.ok(lines.includes('compose.yaml:5 compose-path Dockerfile.dev -> missing'), lines.join('\n'));
  assert.ok(lines.includes('compose.yaml:14 compose-path ./api -> missing'), lines.join('\n'));
  assert.ok(lines.includes('compose.yaml:15 compose-path api.env -> missing'), lines.join('\n'));
  assert.ok(!lines.some((line) => line.includes('./app ')), lines.join('\n'));
});

test('compose-path: values with a variable are skipped, and only docker-compose*.yml and compose*.yml are read', () => {
  const text = 'services:\n  a:\n    build:\n      context: ${DIR}/app\n    env_file: ${ENV_FILE}\n';
  const root = project({ 'docker-compose.override.yml': text, 'other.yml': 'services:\n  a:\n    env_file: gone.env\n' });
  assert.deepEqual(findingLines(refs(root)), []);
});

test('dockerfile-copy: a source that exists passes, a missing one names the instruction line', () => {
  const dockerfile = 'FROM node:22\nCOPY package.json ./\nCOPY src/ /app/src/\nADD gone.tar /tmp/\nCOPY ["a b.txt", "/dest/"]\n';
  const root = project({ Dockerfile: dockerfile, 'package.json': '{}', 'src/a.js': '', 'a b.txt': '' });
  assert.deepEqual(findingLines(refs(root)), ['Dockerfile:4 dockerfile-copy gone.tar -> missing']);
});

test('dockerfile-copy: --from, URLs, variables and flags are skipped; globs match real files; continuation lines count from the first line', () => {
  const dockerfile = [
    'FROM node:22', 'COPY --from=build /out /app', 'ADD https://example.com/x.tgz /tmp/', 'COPY $SRC /app/', 'COPY --chown=1:1 package*.json ./',
    'COPY lib*.js \\', '     gone-two.js /app/', '',
  ].join('\n');
  const root = project({ Dockerfile: dockerfile, 'package.json': '{}', 'lib1.js': '' });
  assert.deepEqual(findingLines(refs(root)), ['Dockerfile:6 dockerfile-copy gone-two.js -> missing']);
});

test('dockerfile-copy: two candidate contexts, present in one gives nothing', () => {
  const dockerfile = 'FROM node:22\nCOPY only-in-root.txt /a\nCOPY only-in-folder.txt /b\nCOPY nowhere.txt /c\n';
  const root = project({ 'docker/Dockerfile': dockerfile, 'only-in-root.txt': '', 'docker/only-in-folder.txt': '' });
  assert.deepEqual(findingLines(refs(root)), ['docker/Dockerfile:4 dockerfile-copy nowhere.txt -> missing']);
});

test('dockerfile-copy: the build context named by a compose file is a candidate too', () => {
  const compose = 'services:\n  app:\n    build:\n      context: ./app\n      dockerfile: ../docker/Dockerfile\n';
  const root = project({ 'docker-compose.yml': compose, 'docker/Dockerfile': 'FROM x\nCOPY main.js /m\nCOPY gone.js /g\n', 'app/main.js': '' });
  assert.deepEqual(findingLines(refs(root)), ['docker/Dockerfile:3 dockerfile-copy gone.js -> missing']);
});

const WORKFLOW = [
  'name: ci', 'jobs:', '  build:', '    runs-on: ubuntu-latest', '    defaults:', '      run:', '        working-directory: ./packages/app', '    steps:',
  '      - uses: actions/checkout@v4', '      - uses: ./.github/actions/setup', '      - uses: ./.github/actions/gone', '      - uses: actions/setup-node@v4',
  '        with:', '          cache-dependency-path: packages/app/pnpm-lock.yaml', '      - run: pnpm test', '        working-directory: ${{ matrix.dir }}',
  '      - run: pnpm build', '        working-directory: "tools/gone"', '',
].join('\n');

test('ci-path: working-directory, cache-dependency-path and local uses; values with ${{ are skipped', () => {
  const root = project({ '.github/workflows/ci.yml': WORKFLOW, '.github/actions/setup/action.yml': '', 'packages/app/x': '' });
  assert.deepEqual(findingLines(refs(root)), [
    '.github/workflows/ci.yml:11 ci-path ./.github/actions/gone -> missing',
    '.github/workflows/ci.yml:14 ci-path packages/app/pnpm-lock.yaml -> missing',
    '.github/workflows/ci.yml:18 ci-path tools/gone -> missing',
  ]);
});

test('ci-path: a glob in cache-dependency-path matches real files; other yml files are not workflows', () => {
  const text = 'steps:\n  - uses: actions/setup-node@v4\n    with:\n      cache-dependency-path: "**/pnpm-lock.yaml"\n';
  const root = project({ '.github/workflows/a.yml': text, 'x/pnpm-lock.yaml': '', 'ci.yml': 'working-directory: gone\n' });
  assert.deepEqual(findingLines(refs(root)), []);
});

test('codeowners-path: patterns without wildcards that match nothing', () => {
  const text = ['# owners', '* @everyone', '*.js @js', '/docs/ @a', '/Docs/guide @b', 'legacy.md @c', 'src/gone/ @d', '/gone/ @e', ''].join('\n');
  const root = project({ '.github/CODEOWNERS': text, 'docs/guide': '', 'deep/legacy.md': '' });
  assert.deepEqual(findingLines(refs(root)), [
    '.github/CODEOWNERS:5 codeowners-path /Docs/guide -> missing',
    '.github/CODEOWNERS:7 codeowners-path src/gone/ -> missing',
    '.github/CODEOWNERS:8 codeowners-path /gone/ -> missing',
  ]);
});

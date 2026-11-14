// Purpose: what the checks must leave alone: lock files, generated files, and names or paths that a framework or
//   language gives a fixed meaning (Maven packages, Next.js routes, Rails helpers, workspace packages, locale files).
// Exports: isLockOrGenerated(path), countedDepth(folderSegments), isFrameworkFolder(folderPath), isLocaleFile(path).
// Invariants: pure; paths are posix and relative to the project root; every rule here is listed in README.md, so a
//   reader can see why a path was not reported.

const LOCK_NAME = /(^|[-.])lock(\.[a-z]+)?$|^go\.sum$/i;
const GENERATED_NAME = /\.(generated|gen|min)\.[a-z]+$|\.pb\.go$|_pb2\.py$|\.d\.ts$/i;
const LOCALE_FOLDERS = new Set(['locales', 'i18n', 'translations']);
const ROUTE_ROOTS = new Set(['app', 'pages']);
const ROUTE_SEGMENT = /^[([].*[)\]]$/; // Next.js (group) and [param]
const MAVEN_LANGUAGES = new Set(['java', 'kotlin', 'scala', 'groovy']);

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

/** True for package-lock.json, pnpm-lock.yaml, yarn.lock, Cargo.lock, go.sum and for generated source (.gen.ts, .pb.go, .d.ts ...). */
export const isLockOrGenerated = (path) => LOCK_NAME.test(baseName(path)) || GENERATED_NAME.test(baseName(path));

/** True for yaml, json and similar files under a locales, i18n or translations folder: every key is a message, not a setting. */
export const isLocaleFile = (path) => path.split('/').slice(0, -1).some((part) => LOCALE_FOLDERS.has(part));

/** Index in `segments` just after a Maven or Gradle `src/main|test/<language>` prefix, or -1 when there is none. */
function mavenPackageStart(segments) {
  for (let i = 0; i + 2 < segments.length; i++) {
    if (segments[i] === 'src' && (segments[i + 1] === 'main' || segments[i + 1] === 'test') && MAVEN_LANGUAGES.has(segments[i + 2])) return i + 3;
  }
  return -1;
}

/**
 * How many folders of this path count against the depth limit. A Maven package path, folders below a Next.js `app/` or
 * `pages/`, and route groups or parameters in `(..)` / `[..]` do not count.
 * @param {string[]} folderSegments folder names between the project root and a file
 */
export function countedDepth(folderSegments) {
  let segments = folderSegments;
  const maven = mavenPackageStart(segments);
  if (maven >= 0) segments = segments.slice(0, maven);
  const route = segments.findIndex((part) => ROUTE_ROOTS.has(part));
  if (route >= 0) segments = segments.slice(0, route + 1);
  return segments.filter((part) => !ROUTE_SEGMENT.test(part)).length;
}

/** True when a folder's name means something to the framework or language, so it is not a dumping ground. */
export function isFrameworkFolder(folderPath) {
  const parts = folderPath.split('/');
  const name = parts[parts.length - 1];
  const parents = parts.slice(0, -1);
  const maven = mavenPackageStart(parts);
  if (maven >= 0 && parts.length > maven) return true;
  if (name === 'helpers' && parents[parents.length - 1] === 'app') return true;
  if (name === 'new' && parents.some((part) => ROUTE_ROOTS.has(part))) return true;
  return (name === 'shared' || name === 'common') && parents[parents.length - 1] === 'packages';
}

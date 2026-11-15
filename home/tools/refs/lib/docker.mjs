// Purpose: readers for docker-compose*.yml / compose*.yml (build context, dockerfile, env_file, bind mounts) and for
//   Dockerfile* (the sources of COPY and ADD).
// Exports: readCompose, readDockerfile.
// Invariants: compose paths are relative to the compose file, `dockerfile` to the build context. The builds found in
//   compose files are pushed to context.composeBuilds, so a Dockerfile is also tried against the context that names it.
//   A Dockerfile source is a finding only when it matches nothing in every candidate context. Values with `$` and URLs
//   are skipped; `COPY --from=...` is skipped.
import { dirname, resolve } from 'node:path';
import { globMatches } from './glob.mjs';
import { hasGlobChars, resolveRef } from './ref-path.mjs';
import { scanYaml } from './yaml-lines.mjs';

const isCheckable = (value) => value !== null && !value.includes('$') && !value.includes('://');
const inBuild = (entry) => entry.parents.length === 3 && entry.parents[0] === 'services' && entry.parents[2] === 'build';

/** Compose references of one entry as {kind: 'compose-path', value, line, base?} or null. `service` names the service. */
function composeReference(entry) {
  const [top, service, section] = entry.parents;
  if (top !== 'services' || service === undefined || !isCheckable(entry.value)) return null;
  const shortForms = entry.parents.length === 2 && ['build', 'env_file'].includes(entry.key) && !entry.isItem;
  const envItem = entry.key === null && entry.parents.length === 3 && section === 'env_file';
  const bindMount = entry.key === null && entry.parents.length === 3 && section === 'volumes' && /^\.\.?\//.test(entry.value);
  if (shortForms || envItem) return { value: entry.value, line: entry.line, role: entry.key ?? 'env_file', service };
  if (bindMount) return { value: entry.value.split(':')[0], line: entry.line, role: 'mount', service };
  if (inBuild(entry) && (entry.key === 'context' || entry.key === 'dockerfile')) return { value: entry.value, line: entry.line, role: entry.key, service };
  return null;
}

/**
 * Compose findings; also records each build (context and dockerfile as absolute paths) in context.composeBuilds.
 * @param {{abs: string, text: string}} file
 * @param {{disk: import('./disk.mjs').Disk, composeBuilds: {context: string, dockerfile: string}[]}} context
 */
export function readCompose(file, { disk, composeBuilds }) {
  const folder = dirname(file.abs);
  const references = scanYaml(file.text).map(composeReference).filter((reference) => reference !== null);
  const results = [];
  const services = [...new Set(references.map((reference) => reference.service))];
  for (const service of services) {
    const mine = references.filter((reference) => reference.service === service);
    const contextRef = mine.find((reference) => reference.role === 'build' || reference.role === 'context');
    const dockerfileRef = mine.find((reference) => reference.role === 'dockerfile');
    const contextPath = resolveRef(folder, contextRef?.value ?? '.');
    if (contextRef !== undefined || dockerfileRef !== undefined) composeBuilds.push({ context: contextPath, dockerfile: resolve(contextPath, dockerfileRef?.value ?? 'Dockerfile') });
    for (const reference of mine) {
      const base = reference.role === 'dockerfile' ? contextPath : folder;
      if (reference.role === 'dockerfile' && !disk.exists(contextPath)) continue; // the missing context is reported already
      if (!disk.exists(resolveRef(base, reference.value))) results.push({ kind: 'compose-path', value: reference.value, line: reference.line });
    }
  }
  return results;
}

/** Lines of the Dockerfile with `\` continuations joined and comments dropped: [{line, text}] (line of the first physical line). */
function instructions(text) {
  const found = [];
  let pending = null;
  text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((raw, index) => {
    if (pending === null && (raw.trim() === '' || raw.trim().startsWith('#'))) return;
    const joined = (pending?.text ?? '') + raw.trim();
    const start = pending?.line ?? index + 1;
    if (joined.endsWith('\\')) pending = { line: start, text: `${joined.slice(0, -1)} ` };
    else {
      found.push({ line: start, text: joined });
      pending = null;
    }
  });
  if (pending !== null) found.push({ line: pending.line, text: pending.text.trim() });
  return found;
}

/** The sources of a COPY/ADD instruction text, or [] when it is not one, copies from another stage, or is unreadable. */
function copySources(text) {
  const match = /^(?:COPY|ADD)\s+(.*)$/i.exec(text);
  if (match === null) return [];
  let tokens;
  if (match[1].startsWith('[')) {
    try {
      tokens = JSON.parse(match[1]);
    } catch {
      return [];
    }
  } else tokens = match[1].split(/\s+/).filter(Boolean);
  const flags = tokens.filter((token) => typeof token === 'string' && token.startsWith('--'));
  if (flags.some((flag) => flag.startsWith('--from')) || !tokens.every((token) => typeof token === 'string')) return [];
  const paths = tokens.filter((token) => !token.startsWith('--'));
  return paths.slice(0, -1).filter((source) => !source.startsWith('<<'));
}

function sourceExists(disk, base, source) {
  const relative = source.replace(/^[\\/]+/, '') || '.';
  return hasGlobChars(relative) ? globMatches(disk, base, relative) : disk.exists(resolveRef(base, relative));
}

/**
 * COPY/ADD sources of a Dockerfile that match nothing in the Dockerfile's folder, the scanned root or a compose context naming it.
 * @param {{abs: string, text: string}} file
 * @param {{disk: import('./disk.mjs').Disk, composeBuilds: {context: string, dockerfile: string}[]}} context
 */
export function readDockerfile(file, { disk, composeBuilds }) {
  const candidates = [dirname(file.abs), disk.root, ...composeBuilds.filter((build) => build.dockerfile === file.abs).map((build) => build.context)];
  return instructions(file.text).flatMap((instruction) => copySources(instruction.text)
    .filter((source) => isCheckable(source) && !candidates.some((base) => sourceExists(disk, base, source)))
    .map((source) => ({ kind: 'dockerfile-copy', value: source, line: instruction.line })));
}

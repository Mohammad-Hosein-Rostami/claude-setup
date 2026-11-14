// Purpose: prove that a control really uses the component the matrix names. A control with `component: "<path>"` must say
// where its surface mounts it (`mountedAt: "<file>:<line>"`), and that file must mention the component; a `{new: reason}`
// control must name its mount site too (no mention test: there is no component to find).
// Exports: reuseProblems(matrix, options), parseMount(value).
// Invariants: pure apart from the injected `readText(path) -> string|null` (null = no such file); without `readText` the
//   file, line and mention tests are skipped (only the missing-field test runs). The mount file is read whole, so the
//   mention may be anywhere in it. Paths resolve from the matrix file's directory, or from `matrix.root` (itself relative
//   to that directory). Mention = the component file's basename without extension, or `control.componentMarker`.
//   Problem codes: unproven-reuse (path component), unproven-mount ({new} component).
import { isAbsolute, parse, resolve } from 'node:path';
import { controlsOf, isReason, isText, problem } from './shape.mjs';

const MOUNT_FORMAT = /^(.+):(\d+)$/;

/** Splits "<file>:<line>" into `{file, line}`; null when the value does not have that form or the line is below 1. */
export function parseMount(value) {
  const match = typeof value === 'string' ? MOUNT_FORMAT.exec(value.trim()) : null;
  return match && Number(match[2]) >= 1 ? { file: match[1].trim(), line: Number(match[2]) } : null;
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// What the mount file has to contain for the control to count as using its component.
const mentionOf = (control) => (isText(control.componentMarker) ? control.componentMarker.trim() : parse(control.component.trim()).name);

function mountProblem(where, control, mount, { base, readText }) {
  const isReuse = isText(control.component);
  const code = isReuse ? 'unproven-reuse' : 'unproven-mount';
  const fail = (message, cause) => problem(code, `${where}: ${message}`, { cause });
  const parsed = parseMount(control.mountedAt);
  if (parsed === null) {
    return fail(`mountedAt ${isText(control.mountedAt) ? `"${control.mountedAt}" is not` : 'is missing; it must be'} "<file>:<line>", the place this surface ${isReuse ? `uses ${control.component}` : 'mounts the control'}${isReuse ? ' (importing or instantiating it)' : ''}`, `${isReuse ? 'component path' : 'new control'} without a valid mountedAt`);
  }
  if (!readText) return null;
  const text = readText(isAbsolute(parsed.file) ? parsed.file : resolve(base, parsed.file));
  if (text === null) return fail(`mountedAt file does not exist: ${parsed.file}`, `mountedAt file does not exist: ${parsed.file}`);
  const lineCount = text.split('\n').length;
  if (parsed.line > lineCount) return fail(`mountedAt line ${parsed.line} does not exist: ${parsed.file} has ${lineCount} lines`, `mountedAt line past the end of ${parsed.file}`);
  if (!isReuse) return null;
  const mention = mentionOf(control);
  if (text.includes(mention)) return null;
  return fail(`${parsed.file} never mentions "${mention}", so this control does not use ${control.component}: a hand-rolled look-alike is {new: reason} or a fail (add componentMarker if the component is used under another name)`, `mount file never mentions the component: ${control.component} in ${parsed.file}`);
}

/**
 * Reuse and mount-site problems of every control.
 * @param {object} matrix a structurally sound matrix
 * @param {{baseDir?: string, readText?: (path: string) => string|null}} [options] baseDir is the matrix file's directory
 * @returns {{code:string,message:string,cause:string}[]} one problem per control that does not prove its component or mount site
 */
export function reuseProblems(matrix, { baseDir = '.', readText } = {}) {
  const base = isText(matrix.root) ? resolve(baseDir, matrix.root.trim()) : baseDir;
  return matrix.surfaces
    .flatMap((surface) => controlsOf(surface).map((control) => ({ surface, control })))
    .filter(({ control }) => isText(control.component) || (isObject(control.component) && isReason(control.component.new)))
    .map(({ surface, control }) => mountProblem(`${surface.id} ${control.id}`, control, control.mountedAt, { base, readText }))
    .filter(Boolean);
}

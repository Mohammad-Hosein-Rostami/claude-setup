// Purpose: for `--changed`, keep only the findings the change itself caused: a new unclear name, a new too-deep folder, a
//   folder that just got its third source file with no README. Findings about old files and folders are dropped.
// Exports: keepWhatChangeAdded(findings, {added, baseFiles}).
// Invariants: pure. Header and config findings are narrowed earlier (only added files, only added keys), so they pass
//   through here untouched. A "new" folder is one with no file under it at the base.
import { isSourceFile, MIN_FILES_FOR_README } from './structure-checks.mjs';

const folderOf = (finding) => (finding.path === './' ? '' : finding.path.replace(/\/$/, ''));
const directFilesOf = (baseFiles, folder) => [...baseFiles].filter((path) => path.slice(0, path.lastIndexOf('/') < 0 ? 0 : path.lastIndexOf('/')) === folder);

/**
 * @param {object[]} findings from the checks
 * @param {{added: Set<string>, baseFiles: Set<string>}} changes what the change added and what existed before
 * @returns {object[]} the findings that belong to the change
 */
export function keepWhatChangeAdded(findings, { added, baseFiles }) {
  const existedBefore = (folder) => [...baseFiles].some((path) => path.startsWith(`${folder}/`));
  return findings.filter((finding) => {
    if (finding.check === 'dumping-ground') return finding.kind === 'file' ? added.has(finding.path) : !existedBefore(folderOf(finding));
    if (finding.check === 'deep-nesting') return finding.files.some((file) => added.has(file));
    if (finding.check === 'no-readme') {
      const sourcesBefore = directFilesOf(baseFiles, folderOf(finding)).filter(isSourceFile).length;
      return sourcesBefore < MIN_FILES_FOR_README && finding.files.some((file) => added.has(file));
    }
    return true;
  });
}

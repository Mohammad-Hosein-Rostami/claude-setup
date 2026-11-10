// Purpose: the pixel gate - odiff (threshold 0.1, anti-aliasing ignored) with size-mismatch padding.
// Exports: pixelCheck. Invariant: a size mismatch always fails the gate, but the padded diff is still produced.
import path from 'node:path';
import { UsageError } from './errors.mjs';
import { readPng, writePng, padTo, diffRegion } from './image.mjs';
import { PIXEL } from './tolerances.mjs';

async function loadOdiff() {
  try {
    const mod = await import('odiff-bin');
    return mod.compare ?? mod.default?.compare;
  } catch (error) {
    if (error.code === 'ERR_MODULE_NOT_FOUND') throw new UsageError('odiff-bin is not installed (run pnpm install in the ui-check folder)');
    throw error;
  }
}

function alignSizes(baselineFile, actualFile, outDir) {
  const base = readPng(baselineFile);
  const actual = readPng(actualFile);
  if (base.width === actual.width && base.height === actual.height) {
    return { baseFile: baselineFile, actualFile, base, actual, sizeMismatch: null };
  }
  const width = Math.max(base.width, actual.width);
  const height = Math.max(base.height, actual.height);
  const paddedBase = padTo(base, width, height);
  const paddedActual = padTo(actual, width, height);
  const baseFile = path.join(outDir, 'baseline.padded.png');
  const paddedFile = path.join(outDir, 'actual.padded.png');
  writePng(baseFile, paddedBase);
  writePng(paddedFile, paddedActual);
  return {
    baseFile, actualFile: paddedFile, base: paddedBase, actual: paddedActual,
    sizeMismatch: { baseline: [base.width, base.height], actual: [actual.width, actual.height] },
  };
}

/**
 * Diff the captured element against the Figma baseline.
 * @param {{baselineFile: string, actualFile: string, outDir: string, maxDiffPercent: number}} opts
 * @returns {Promise<{pass: boolean, diffPercent: number, diffCount: number, region: object | null, sizeMismatch: object | null, diffFile: string}>}
 * @throws {UsageError} if odiff-bin is not installed
 */
export async function pixelCheck({ baselineFile, actualFile, outDir, maxDiffPercent }) {
  const compare = await loadOdiff();
  const aligned = alignSizes(baselineFile, actualFile, outDir);
  const diffFile = path.join(outDir, 'diff.png');
  const result = await compare(aligned.baseFile, aligned.actualFile, diffFile, {
    threshold: PIXEL.threshold, antialiasing: true, captureDiffLines: true, failOnLayoutDiff: false,
  });
  // Any non-pixel failure (missing file, layout diff) must not read as "0 different pixels".
  if (!result.match && result.reason !== 'pixel-diff') throw new UsageError(`odiff failed: ${result.reason} ${result.file ?? ''}`.trim());
  const total =aligned.base.width * aligned.base.height;
  const diffCount = result.match ? 0 : (result.diffCount ?? 0);
  const diffPercent = (diffCount / total) * 100;
  const region = result.match ? null : diffRegion(aligned.base, aligned.actual, result.diffLines);
  return { pass: !aligned.sizeMismatch && diffPercent <= maxDiffPercent, diffPercent, diffCount, region, sizeMismatch: aligned.sizeMismatch, diffFile };
}

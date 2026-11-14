// Masks anything secret-shaped in text that is about to be printed or logged.
// Exports: maskText(text) -> string.
// Layers: the guard's maskSecrets (command-shaped secrets: Bearer, API keys, tokens, key=value), then token shapes (sk-..., ghp_...,
// xox...-...), key=value / key: value secrets in prose, long hex runs (>= 32) and long mixed-case base64-like runs (>= 40).
// A path never matches the base64 rule (its slashes and hyphens break the run and it needs upper, lower and a digit).
// Invariants: pure; never throws on odd input; over-masking is accepted, leaking is not.
import { maskSecrets } from '../../../hooks/lib/secrets.mjs';

const MASK = '[masked]';
const TOKEN_SHAPES = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
];
const KEY_VALUE = /\b([A-Za-z0-9_-]*(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)[A-Za-z0-9_-]*)(\s*[=:]\s*)(['"]?)[^\s'"]{8,}/gi;
const BASE64_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;
const MIXED = [/[A-Z]/, /[a-z]/, /[0-9]/];

/**
 * @param {unknown} text what is about to be printed or logged
 * @returns {string} the text with secret-looking parts replaced by "[masked]"
 */
export function maskText(text) {
  let masked = maskSecrets(String(text ?? ''));
  for (const shape of TOKEN_SHAPES) masked = masked.replace(shape, MASK);
  masked = masked.replace(KEY_VALUE, `$1$2$3${MASK}`);
  return masked.replace(BASE64_RUN, (run) => (MIXED.every((part) => part.test(run)) ? MASK : run));
}

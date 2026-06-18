import { createHash } from 'node:crypto';

// The pure, browser-safe helpers live in ./runtime (no node:* imports) so the
// client i18n layer can bundle them. They are re-exported here to preserve the
// `./utils` import surface used across the server/worker code.
export {
  buildLocaleFallbackChain,
  isPlainObject,
  normalizeLocale,
  renderTemplate,
} from './runtime.js';

import { normalizeLocale } from './runtime.js';

/** Stable hash used to gate auto-translation re-runs against a specific source. */
export function computeSourceHash(template: string): string {
  return `sha256:${createHash('sha256').update(template, 'utf8').digest('hex')}`;
}

/** Deterministic translation-job ID — used for stampede protection. */
export function buildTranslationJobId(
  key: string,
  targetLocale: string,
): string {
  return `smrt-languages.translate:${key}:${normalizeLocale(targetLocale)}`;
}

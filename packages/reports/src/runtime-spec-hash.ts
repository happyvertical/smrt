/**
 * Server-side stable hash of a normalized runtime report spec (#3711, #4100).
 *
 * Kept apart from `runtime-spec.ts` because it needs `node:crypto`: the
 * grammar itself is browser-safe and ships on the `./spec` subpath. Browsers
 * use `runtimeReportSpecDigest()` (Web Crypto), which yields the same hex.
 */

import { createHash } from 'node:crypto';
import {
  type RuntimeReportSpec,
  serializeRuntimeReportSpec,
} from './runtime-spec.js';

/** Stable fingerprint of a NORMALIZED spec; equal specs hash equally. */
export function runtimeReportSpecHash(spec: RuntimeReportSpec): string {
  return createHash('sha256')
    .update(serializeRuntimeReportSpec(spec))
    .digest('hex');
}

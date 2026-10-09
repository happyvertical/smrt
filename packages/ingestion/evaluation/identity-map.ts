import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export interface CaseIdentityMap {
  caseId: string;
  corpusManifestSha256: string;
  /** Logical frozen corpus label -> actual owning database UUID. */
  entries: Array<{ logical: string; actual: string }>;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validate(value: CaseIdentityMap): void {
  if (
    !value.caseId?.trim() ||
    !/^[0-9a-f]{64}$/.test(value.corpusManifestSha256) ||
    !Array.isArray(value.entries)
  )
    throw Error('Invalid case identity map');
  const logical = new Set<string>(),
    actual = new Set<string>();
  for (const entry of value.entries) {
    if (
      !entry.logical?.trim() ||
      !uuid.test(entry.actual) ||
      logical.has(entry.logical) ||
      actual.has(entry.actual)
    )
      throw Error('Case identity mapping must be an exact bijection');
    logical.add(entry.logical);
    actual.add(entry.actual);
  }
}
/** Called after immutable source receipt IDs exist, before any provider call.
 * Never derive mappings from a provider suggestion or fuzzy label match.
 */
export function freezeCaseIdentity(
  path: string,
  mapping: CaseIdentityMap,
): string {
  validate(mapping);
  const bytes = `${JSON.stringify(mapping)}\n`;
  writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return createHash('sha256').update(bytes).digest('hex');
}
export function readCaseIdentity(
  path: string,
  digest: string,
): CaseIdentityMap {
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw Error('Changed frozen case identity map');
  const mapping = JSON.parse(bytes.toString()) as CaseIdentityMap;
  validate(mapping);
  return mapping;
}
/** Unknown provider IDs fail comparison; no fallback, inference or new mapping. */
export function logicalIdentity(
  mapping: CaseIdentityMap,
  actual: string,
): string {
  validate(mapping);
  const entry = mapping.entries.find((entry) => entry.actual === actual);
  if (!entry) throw Error('Unmapped provider identity');
  return entry.logical;
}

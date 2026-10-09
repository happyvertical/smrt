import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './corpus.mjs';
export function feedbackCases() {
  const protocolBytes = readFileSync(
    new URL('./feedback-protocol.json', import.meta.url),
  );
  const protocol = JSON.parse(protocolBytes);
  const cases = [];
  for (const row of protocol.training)
    cases.push({
      id: `feedback-train-${row.family}`,
      family: row.family,
      arm: 'training',
      text: row.text,
      expectedTarget: row.expectedTarget,
    });
  for (const row of protocol.pairedHeldout)
    for (const arm of row.order)
      cases.push({
        id: `feedback-${arm}-${row.family}`,
        family: row.family,
        arm,
        text: row.text,
        expectedTarget: row.expectedTarget,
      });
  if (
    cases.length !== protocol.maximumPaidCalls ||
    new Set(cases.map((row) => row.id)).size !== cases.length
  )
    throw Error('Invalid frozen feedback schedule');
  return {
    version: protocol.version,
    protocolSha256: sha256(protocolBytes),
    cases: cases.map((row) => ({
      ...row,
      source: {
        path: `${row.id}.txt`,
        mediaType: 'text/plain',
        byteLength: Buffer.byteLength(row.text),
        sha256: sha256(row.text),
      },
    })),
  };
}
/** Pure authoring step before release, never coupled to model results. */
export function materializeFeedback(root) {
  const manifest = feedbackCases();
  mkdirSync(root, { recursive: false });
  for (const row of manifest.cases)
    writeFileSync(join(root, row.source.path), row.text, { flag: 'wx' });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(root, 'manifest.json'), bytes, { flag: 'wx' });
  return { manifest, manifestSha256: sha256(bytes) };
}

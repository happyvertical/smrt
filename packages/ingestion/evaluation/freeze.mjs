import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateCorpus } from './corpus.mjs';

const here = dirname(fileURLToPath(import.meta.url));
/** Verify actual materialized bytes against the committed index; never silently rebuild. */
export function verifyMaterialization(index, root) {
  const manifestBytes = readFileSync(join(root, 'manifest.json'));
  if (sha256(manifestBytes) !== index.manifestSha256)
    throw new Error('Frozen manifest mismatch');
  const manifest = JSON.parse(manifestBytes);
  if (
    sha256(readFileSync(join(here, 'generate-corpus.mjs'))) !==
      index.generatorHash ||
    sha256(readFileSync(join(here, 'corpus/v1/families.json'))) !==
      index.familyHash
  )
    throw new Error('Frozen generator/families changed');
  const summary = validateCorpus(manifest, root, {
    requireHeldoutCoverage: index.version === 'synthetic-reference-v1',
  });
  const groupRows = [...new Set(manifest.cases.map((item) => item.group))].map(
    (group) => {
      const cases = manifest.cases.filter((item) => item.group === group);
      return [
        group,
        cases[0].partition,
        cases[0].category,
        cases.length,
        sha256(JSON.stringify(cases)),
      ];
    },
  );
  if (
    JSON.stringify(groupRows) !== JSON.stringify(index.groups) ||
    JSON.stringify(summary) !== JSON.stringify(index.summary) ||
    manifest.generatorHash !== index.generatorHash ||
    manifest.familyHash !== index.familyHash ||
    JSON.stringify(manifest.tools) !== JSON.stringify(index.tools)
  )
    throw new Error('Frozen corpus index mismatch');
  return { manifest, summary };
}
/** Freeze records are hash receipts, never authorization to spend or a quality claim. */
export function freezeReceipt(
  indexPath,
  corpusRoot,
  protocolPath,
  runProfilePath,
) {
  const indexBytes = readFileSync(indexPath);
  const index = JSON.parse(indexBytes);
  const { summary } = verifyMaterialization(index, corpusRoot);
  const protocolBytes = readFileSync(protocolPath);
  const profileBytes = readFileSync(runProfilePath);
  const protocol = JSON.parse(protocolBytes);
  const profile = JSON.parse(profileBytes);
  const feedbackProtocolSha256 = sha256(
    readFileSync(join(here, 'feedback-protocol.json')),
  );
  if (profile.feedbackProtocolSha256 !== feedbackProtocolSha256)
    throw new Error('Frozen feedback protocol mismatch');
  if (
    !summary.minimumHeldoutMet ||
    !summary.heldoutCoverageMet ||
    protocol.version !== index.version ||
    profile.corpusVersion !== index.version
  )
    throw new Error('Freeze prerequisites missing');
  return {
    version: index.version,
    indexSha256: sha256(indexBytes),
    manifestSha256: index.manifestSha256,
    protocolSha256: sha256(protocolBytes),
    runProfileSha256: sha256(profileBytes),
    scorerSha256: sha256(readFileSync(join(here, 'scoring.mjs'))),
    feedbackProtocolSha256,
    summary,
    authorizesPaidCalls: false,
    automationEligible: false,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [index, corpus, protocol, profile, receipt] = process.argv.slice(2);
  if (!receipt)
    throw new Error(
      'Usage: freeze.mjs INDEX CORPUS PROTOCOL RUN_PROFILE RECEIPT',
    );
  writeFileSync(
    receipt,
    `${JSON.stringify(freezeReceipt(index, corpus, protocol, profile), null, 2)}\n`,
    { flag: 'wx' },
  );
}

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PROPOSAL_BOUND } from './bounded-chat.mjs';
import { tokenChargeBound } from './budget.mjs';
import { sha256 } from './corpus.mjs';
export const LIVE_LEDGER =
  '/home/will/Work/tmp/smrt-epic-3668/evaluation-budget.sqlite';
export const AGGREGATE_CAP = 5_000_000_000;
/** Stable file receipt, not a signature or authorization against a hostile host. */
export function fileTreeReceipt(root, paths) {
  const files = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isSymbolicLink()) throw Error('Unexpected artifact symlink');
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
    }
  };
  for (const path of paths) {
    const resolved = join(root, path);
    if (path.endsWith('/')) walk(resolved);
    else files.push(resolved);
  }
  const rows = files
    .sort()
    .map((path) => [relative(root, path), sha256(readFileSync(path))]);
  return { sha256: sha256(JSON.stringify(rows)), files: rows };
}
export function scheduleBound(manifest, feedbackManifest) {
  const heldout = manifest.cases.filter((row) => row.partition === 'heldout');
  const eligible = heldout.filter((row) => row.lane === 'provider-quality');
  const sources = eligible.flatMap((row) => row.sources);
  if (
    heldout.length !== 300 ||
    eligible.length !== 280 ||
    eligible.some((row) => row.sources.length !== 1) ||
    sources.some(
      (source) =>
        !['text/plain', 'application/pdf', 'image/png', 'audio/wav'].includes(
          source.mediaType,
        ),
    ) ||
    feedbackManifest.cases.length !== 11 ||
    feedbackManifest.cases.some((row) => row.source.mediaType !== 'text/plain')
  )
    throw Error('Schedule outside frozen provider routes');
  const proposal = tokenChargeBound({
    inputTokens:
      PROPOSAL_BOUND.maxSerializedBytes + PROPOSAL_BOUND.framingTokens,
    outputTokens: PROPOSAL_BOUND.maxOutputTokens,
    inputNanoUSD: PROPOSAL_BOUND.inputNanoUSD,
    outputNanoUSD: PROPOSAL_BOUND.outputNanoUSD,
  });
  const vision = tokenChargeBound({
    inputTokens: 4096 + 512 + 1230,
    outputTokens: 4096,
    inputNanoUSD: 750,
    outputNanoUSD: 4500,
  });
  const speech = 30000000;
  const imageCalls = sources.filter(
    (source) => source.mediaType === 'image/png',
  ).length;
  const speechCalls = sources.filter(
    (source) => source.mediaType === 'audio/wav',
  ).length;
  if (imageCalls !== 28 || speechCalls !== 28)
    throw Error('Changed paid media schedule');
  const heldoutMaximum =
    eligible.length * proposal + imageCalls * vision + speechCalls * speech;
  const feedbackMaximum = feedbackManifest.cases.length * proposal;
  const feedbackReserve = 400000000;
  if (
    feedbackMaximum > feedbackReserve ||
    heldoutMaximum + feedbackReserve > AGGREGATE_CAP
  )
    throw Error('Aggregate schedule exceeds approved cap');
  return {
    heldoutCases: heldout.length,
    proposalCalls: eligible.length,
    imageCalls,
    speechCalls,
    heldoutMaximum,
    feedbackCalls: feedbackManifest.cases.length,
    feedbackMaximum,
    feedbackReserve,
    maximumWithReserve: heldoutMaximum + feedbackReserve,
  };
}
/** Root supplies this external release only after frozen evidence inspection.
 * A draft profile, differing code/build/corpus, or larger cap fails before SDK setup.
 */
export function assertPaidRelease(release, frozen) {
  const digests = [
    'profileSha256',
    'protocolSha256',
    'manifestSha256',
    'feedbackManifestSha256',
    'sourceTreeSha256',
    'builtTreeSha256',
  ];
  if (
    release?.allowPaidCalls !== true ||
    release.aggregateCapNanoUSD !== AGGREGATE_CAP ||
    release.ledgerPath !== LIVE_LEDGER ||
    frozen.profileStatus !== 'frozen-awaiting-release'
  )
    throw Error('Paid evaluation has not been released');
  if (
    !/^[a-f0-9]{40}$/.test(frozen.gitHead ?? '') ||
    release.gitHead !== frozen.gitHead ||
    frozen.workingTreeClean !== true ||
    release.workingTreeClean !== true
  )
    throw Error('Paid release requires the exact clean repository HEAD');
  for (const key of digests)
    if (
      !/^[a-f0-9]{64}$/.test(frozen[key] ?? '') ||
      release[key] !== frozen[key]
    )
      throw Error('Paid release frozen artifact mismatch');
  if (release.startingChargedNanoUSD !== 0 || release.startingCalls !== 0)
    throw Error('Initial ledger inspection required');
  return {
    runHash: sha256(
      JSON.stringify(
        Object.fromEntries(
          [...digests, 'gitHead'].map((key) => [key, frozen[key]]),
        ),
      ),
    ),
    ledgerPath: LIVE_LEDGER,
    aggregateCapNanoUSD: AGGREGATE_CAP,
  };
}

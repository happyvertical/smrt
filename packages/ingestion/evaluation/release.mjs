import {
  existsSync,
  globSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROPOSAL_BOUND } from './bounded-chat.mjs';
import { tokenChargeBound } from './budget.mjs';
import { sha256 } from './corpus.mjs';
export const LIVE_LEDGER =
  '/home/will/Work/tmp/smrt-epic-3668/evaluation-budget.sqlite';
export const AGGREGATE_CAP = 5_000_000_000;
/** Stable file receipt, not a signature or authorization against a hostile host. */
export function fileTreeReceipt(root, paths) {
  const files = new Set();
  const walk = (path) => {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith(`..${sep}`))
      throw Error('Artifact escapes repository');
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error('Unexpected artifact symlink');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
    } else if (stat.isFile()) files.add(path);
    else throw Error('Unexpected artifact file type');
  };
  for (const path of paths) walk(resolve(root, path));
  const rows = [...files]
    .sort()
    .map((path) => [relative(root, path), sha256(readFileSync(path))]);
  return { sha256: sha256(JSON.stringify(rows)), files: rows };
}
/** Conservative superset: every declared workspace build and public export, not
 * a guessed static import graph. Installed workspace edges must resolve locally.
 */
export function workspaceBuildReceipt(root) {
  root = realpathSync(root);
  const yaml = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8');
  const block = /^packages:\r?\n((?:[ \t]+[^\n]*\n|\s*\n)*)/m.exec(yaml)?.[1];
  if (!block) throw Error('Workspace declarations unavailable');
  const patterns = block
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^- ['"]?(packages\/[a-zA-Z0-9_/*-]+)['"]?$/.exec(line);
      if (!match) throw Error('Unexpected workspace declaration');
      return `${match[1]}/package.json`;
    });
  const manifests = [
    ...new Set(patterns.flatMap((pattern) => globSync(pattern, { cwd: root }))),
  ].sort();
  if (!manifests.length) throw Error('Workspace packages unavailable');
  const packages = new Map();
  const paths = ['pnpm-workspace.yaml'];
  for (const metadata of ['package.json', 'pnpm-lock.yaml']) {
    if (existsSync(join(root, metadata))) paths.push(metadata);
  }
  for (const manifest of manifests) {
    const path = join(root, manifest);
    const pkg = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof pkg.name !== 'string' || packages.has(pkg.name))
      throw Error('Invalid workspace identity');
    packages.set(pkg.name, { path, pkg });
    paths.push(manifest);
  }
  for (const { path, pkg } of packages.values()) {
    const directory = dirname(path);
    const dist = join(directory, 'dist');
    if (existsSync(dist)) paths.push(relative(root, dist));
    const exports = (value) => {
      if (value === null) return;
      if (typeof value === 'string') {
        if (!value.startsWith('./') || value.split('/').includes('..'))
          throw Error('Unexpected workspace export');
        const targets = value.includes('*')
          ? globSync(value, { cwd: directory })
          : [value];
        if (!targets.length) throw Error('Missing workspace export');
        for (const target of targets) {
          const absolute = resolve(directory, target);
          if (
            !absolute.startsWith(`${directory}${sep}`) ||
            !existsSync(absolute)
          )
            throw Error('Missing or unexpected workspace export');
          paths.push(relative(root, absolute));
        }
      } else if (value && typeof value === 'object') {
        for (const target of Object.values(value)) exports(target);
      } else throw Error('Unexpected workspace export shape');
    };
    if (pkg.exports !== undefined) exports(pkg.exports);
    for (const field of ['main', 'module', 'types']) {
      if (pkg[field])
        exports(pkg[field].startsWith('./') ? pkg[field] : `./${pkg[field]}`);
    }
    for (const field of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [name, version] of Object.entries(pkg[field] ?? {})) {
        const expected = packages.get(name);
        if (!expected) {
          if (String(version).startsWith('workspace:'))
            throw Error('Undeclared workspace dependency');
          continue;
        }
        const installed = findPackageJSON(name, pathToFileURL(path));
        if (
          !installed ||
          realpathSync(installed) !== realpathSync(expected.path)
        )
          throw Error('Unexpected workspace dependency resolution');
      }
    }
  }
  return fileTreeReceipt(root, paths);
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

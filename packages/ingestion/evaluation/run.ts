import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BudgetLedger } from './budget.mjs';
import { recoverProjection } from './case-observation.js';
import { readFrozenSource } from './case-source.js';
import { sha256 } from './corpus.mjs';
import { feedbackCases } from './feedback-cases.mjs';
import { verifyMaterialization } from './freeze.mjs';
import { assertNativeScope } from './native-scope.mjs';
import type { ReferenceCase } from './reference-case.js';
import {
  assertPaidRelease,
  fileTreeReceipt,
  LIVE_LEDGER,
  scheduleBound,
  workspaceBuildReceipt,
} from './release.mjs';
import { exactActionMatch, scoreCases, scoreStrata } from './scoring.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, '../../..');
interface RunPaths {
  corpusRoot: string;
  feedbackRoot: string;
  profilePath: string;
  releasePath: string;
  outputRoot: string;
}
function installedVersion(specifier: string): string {
  let directory = dirname(fileURLToPath(import.meta.resolve(specifier)));
  for (;;) {
    const path = join(directory, 'package.json');
    if (existsSync(path)) {
      const pkg = JSON.parse(readFileSync(path, 'utf8'));
      if (pkg.name === specifier) return String(pkg.version);
    }
    const parent = dirname(directory);
    if (parent === directory)
      throw Error('Installed provider metadata unavailable');
    directory = parent;
  }
}
/** Read-only preparation; a receipt never grants permission to infer. */
export function prepareEvaluation(
  paths: Pick<RunPaths, 'corpusRoot' | 'feedbackRoot' | 'profilePath'>,
) {
  const index = JSON.parse(
    readFileSync(join(here, 'corpus/v1/index.json'), 'utf8'),
  );
  const { manifest } = verifyMaterialization(index, paths.corpusRoot);
  const feedbackBytes = readFileSync(join(paths.feedbackRoot, 'manifest.json'));
  const feedbackManifest = JSON.parse(feedbackBytes.toString());
  if (JSON.stringify(feedbackManifest) !== JSON.stringify(feedbackCases()))
    throw Error('Feedback materialization mismatch');
  for (const row of feedbackManifest.cases)
    readFrozenSource(paths.feedbackRoot, row.source);
  const profileBytes = readFileSync(paths.profilePath);
  const profile = JSON.parse(profileBytes.toString());
  const protocolBytes = readFileSync(join(here, 'protocol.json'));
  if (
    profile.feedbackProtocolSha256 !==
    sha256(readFileSync(join(here, 'feedback-protocol.json')))
  )
    throw Error('Feedback protocol profile mismatch');
  for (const [specifier, version] of Object.entries(profile.selectedPackages))
    if (installedVersion(specifier) !== version)
      throw Error('Installed provider version mismatch');
  const smrtVersion = JSON.parse(
    readFileSync(join(here, '../package.json'), 'utf8'),
  ).version;
  if (profile.smrtVersion !== smrtVersion)
    throw Error('SMRT run version not pinned');
  const source = fileTreeReceipt(repository, [
    'packages/ingestion/evaluation/',
    'packages/ingestion/reference/',
    'packages/ingestion/src/',
    'packages/ingestion/package.json',
    'pnpm-lock.yaml',
    'package.json',
  ]);
  const built = workspaceBuildReceipt(repository);
  const gitHead = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repository,
    encoding: 'utf8',
  }).trim();
  const workingTreeClean =
    execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repository,
      encoding: 'utf8',
    }).trim().length === 0;
  const frozen = {
    gitHead,
    workingTreeClean,
    profileStatus: profile.status,
    profileSha256: sha256(profileBytes),
    protocolSha256: sha256(protocolBytes),
    manifestSha256: index.manifestSha256,
    feedbackManifestSha256: sha256(feedbackBytes),
    sourceTreeSha256: source.sha256,
    builtTreeSha256: built.sha256,
  };
  return {
    frozen,
    source,
    built,
    schedule: scheduleBound(manifest, feedbackManifest),
    manifest,
    profile,
  };
}
/** Only invoked with the coordinator's external frozen release receipt. No retry,
 * calibration, alternate ledger, optional decision model or network fallback.
 */
export async function runApprovedEvaluation(paths: RunPaths) {
  const prepared = prepareEvaluation(paths);
  const release = JSON.parse(readFileSync(paths.releasePath, 'utf8'));
  const authorized = assertPaidRelease(release, prepared.frozen);
  const native = assertNativeScope();
  if (!existsSync(LIVE_LEDGER) || realpathSync(LIVE_LEDGER) !== LIVE_LEDGER)
    throw Error('Canonical inspected ledger unavailable');
  const outputRoot = resolve(paths.outputRoot);
  if (outputRoot === repository || outputRoot.startsWith(`${repository}${sep}`))
    throw Error('Measured artifacts must remain external');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw Error('Required provider credential unavailable');
  const ledger = new BudgetLedger(LIVE_LEDGER);
  try {
    const initial = ledger.snapshot();
    if (
      initial.halted ||
      initial.charged !== release.startingChargedNanoUSD ||
      initial.calls.length !== release.startingCalls
    )
      throw Error('Live ledger differs from initial inspected release');
    const { runFeedbackCohort } = await import('./feedback-run.js');
    const { projectSuggestion } = await import('./prediction.js');
    const { runReferenceCase } = await import('./reference-case.js');
    const { createReferenceProviderOptions } = await import(
      './reference-providers.js'
    );
    mkdirSync(outputRoot, { recursive: false });
    writeFileSync(
      join(outputRoot, 'frozen-run.json'),
      JSON.stringify({
        ...prepared,
        frozen: prepared.frozen,
        manifest: undefined,
        native,
        initialLedger: initial,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    const cases = prepared.manifest.cases.filter(
      (row: { partition: string }) => row.partition === 'heldout',
    );
    const predictions: Array<Record<string, unknown>> = [];
    const heldoutRoot = join(outputRoot, 'heldout');
    mkdirSync(heldoutRoot);
    for (const row of cases) {
      if (ledger.snapshot().halted) break;
      try {
        const item: ReferenceCase = {
          id: row.id,
          lane: row.lane,
          sources: row.sources,
          candidates: row.candidates,
          fixtureContext: row.fixtureContext,
        };
        const configured = await createReferenceProviderOptions({
          item,
          ledger,
          runHash: authorized.runHash,
          profileDigest: prepared.frozen.profileSha256,
          apiKey,
          baseUrl: 'https://api.openai.com/v1',
          cohort: 'heldout',
        });
        const remainingLabels = [...row.expected];
        const result = await runReferenceCase({
          item,
          corpusRoot: paths.corpusRoot,
          artifactsRoot: heldoutRoot,
          manifestSha256: prepared.frozen.manifestSha256,
          capturedAt: new Date().toISOString(),
          hostOptions: configured.hostOptions,
          modelWasInvoked: configured.modelWasInvoked,
          reviewSuggestion: (suggestion, mapping) => {
            const offer = projectSuggestion(suggestion, mapping);
            const index = remainingLabels.findIndex((label) =>
              exactActionMatch(label, offer),
            );
            if (index < 0) return 'reject';
            remainingLabels.splice(index, 1);
            return 'approve';
          },
        });
        predictions.push({
          ...result.prediction,
          charge: { kind: 'unknown' },
          fallback: false,
        });
      } catch {
        // Do not retain exception text, credentials, or an inferred structural success.
        predictions.push(
          recoverProjection(heldoutRoot, row.id) ?? {
            id: row.id,
            status: 'provider_failure',
            actions: [],
            abstained: false,
            charge: { kind: 'unknown' },
            failure: 'bounded_case_failed_no_retry',
          },
        );
      }
      writeFileSync(
        join(outputRoot, `prediction-${row.id}.json`),
        JSON.stringify(predictions.at(-1)),
        { flag: 'wx', mode: 0o600 },
      );
    }
    const score = scoreCases(cases, predictions, {
      provider: 'OpenAI via owning SDK adapters',
      model: prepared.profile.proposalAndVisionModel,
      runDigest: authorized.runHash,
    });
    writeFileSync(
      join(outputRoot, 'heldout-score.json'),
      JSON.stringify(score),
      { flag: 'wx', mode: 0o600 },
    );
    let feedback: unknown = { status: 'unavailable', reason: 'ledger_halted' };
    if (!ledger.snapshot().halted) {
      try {
        feedback = await runFeedbackCohort({
          materializationRoot: paths.feedbackRoot,
          artifactsRoot: join(outputRoot, 'feedback'),
          expectedManifestSha256: prepared.frozen.feedbackManifestSha256,
          createProviders: (item) =>
            createReferenceProviderOptions({
              item,
              ledger,
              runHash: authorized.runHash,
              profileDigest: prepared.frozen.profileSha256,
              apiKey,
              baseUrl: 'https://api.openai.com/v1',
              cohort: 'feedback',
            }),
        });
      } catch {
        feedback = {
          status: 'incomplete',
          reason: 'bounded_feedback_failed_no_retry',
          retainedPartialArtifacts: true,
          missingPairsAreFailures: true,
        };
      }
    }
    const report = {
      runHash: authorized.runHash,
      frozen: prepared.frozen,
      schedule: prepared.schedule,
      score,
      strata: scoreStrata(cases, predictions, score.profile),
      supportedReferenceClaim: false,
      supportedReferenceLimitation:
        'Known generic corrupt-evidence failures prevent the frozen system-abstention gate; observed metrics and any additional failures remain authoritative.',
      feedback,
      budget: ledger.snapshot(),
      automationEligible: false,
      measuredHumanReview: false,
      syntheticDomainOnly: true,
    };
    writeFileSync(join(outputRoot, 'report.json'), JSON.stringify(report), {
      flag: 'wx',
      mode: 0o600,
    });
    return report;
  } finally {
    ledger.close();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [mode, corpusRoot, feedbackRoot, profilePath, releasePath, outputRoot] =
    process.argv.slice(2);
  if (mode === 'prepare') {
    if (!corpusRoot || !feedbackRoot || !profilePath || !releasePath)
      throw Error(
        'Usage: run.ts prepare CORPUS FEEDBACK PROFILE EXTERNAL_RECEIPT',
      );
    const prepared = prepareEvaluation({
      corpusRoot,
      feedbackRoot,
      profilePath,
    });
    writeFileSync(
      releasePath,
      JSON.stringify({
        ...prepared,
        manifest: undefined,
        authorizesPaidCalls: false,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    process.stdout.write(
      'Prepared immutable receipt; paid calls remain unauthorized.\n',
    );
  } else {
    if (
      mode !== 'run' ||
      !corpusRoot ||
      !feedbackRoot ||
      !profilePath ||
      !releasePath ||
      !outputRoot
    )
      throw Error(
        'Usage: run.ts run CORPUS FEEDBACK PROFILE RELEASE EXTERNAL_OUTPUT',
      );
    try {
      const report = await runApprovedEvaluation({
        corpusRoot,
        feedbackRoot,
        profilePath,
        releasePath,
        outputRoot,
      });
      process.stdout.write(
        JSON.stringify({
          outputRoot,
          chargedReservationNanoUSD: report.budget.charged,
          automationEligible: false,
        }) + '\n',
      );
    } catch {
      process.stderr.write(
        'Evaluation stopped; no automatic retry. Preserve the canonical ledger and protected run artifacts.\n',
      );
      process.exitCode = 1;
    }
  }
}

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contents } from '@happyvertical/smrt-content';
import { DOCUMENT } from '../reference/handlers.js';
import {
  ReferenceReviewHost,
  ReferenceReviewWorker,
} from '../reference/review-host.js';
import type { FeedbackConfiguration } from '../src/feedback-contracts.js';
import { readFrozenSource } from './case-source.js';
import { sha256 } from './corpus.mjs';
import { feedbackCases } from './feedback-cases.mjs';
import { recordTrainingCorrection } from './feedback-review.js';
import {
  EVALUATION_SCOPE,
  type ReferenceCase,
  runReferenceCase,
} from './reference-case.js';
import type { createReferenceProviderOptions } from './reference-providers.js';

type ProviderOptions = Awaited<
  ReturnType<typeof createReferenceProviderOptions>
>;
/** Shared retained application context is restricted to this preregistered cohort.
 * Only training rows may create judgments; heldout rows never become examples.
 */
export async function runFeedbackCohort(input: {
  materializationRoot: string;
  artifactsRoot: string;
  expectedManifestSha256: string;
  createProviders(item: ReferenceCase): Promise<ProviderOptions>;
}) {
  const bytes = readFileSync(join(input.materializationRoot, 'manifest.json'));
  const manifest = JSON.parse(bytes.toString()) as ReturnType<
    typeof feedbackCases
  >;
  if (
    sha256(bytes) !== input.expectedManifestSha256 ||
    JSON.stringify(manifest) !== JSON.stringify(feedbackCases())
  )
    throw Error('Changed frozen feedback cohort');
  for (const row of manifest.cases)
    readFrozenSource(input.materializationRoot, row.source);
  const protocol = JSON.parse(
    readFileSync(new URL('./feedback-protocol.json', import.meta.url), 'utf8'),
  );
  const candidates = (protocol.catalog.targets as string[]).map((title) => ({
    id: title,
    title,
  }));
  const makeItem = (row: (typeof manifest.cases)[number]): ReferenceCase => ({
    id: row.id,
    lane: 'provider-quality',
    sources: [row.source],
    candidates,
    fixtureContext: { hiddenTargets: [] },
  });
  const feedback: FeedbackConfiguration = {
    ...protocol.feedbackConfiguration,
    authorize: async ({ db, scope }) => {
      if (
        scope.tenantId !== EVALUATION_SCOPE.tenantId ||
        scope.confidentialScopeId !== EVALUATION_SCOPE.confidentialScopeId ||
        !['owner', 'reviewer'].includes(scope.actorId)
      )
        return false;
      return (
        (
          await db.query(
            'UPDATE review_grants SET actor_id=actor_id WHERE actor_id=? AND enabled=1 RETURNING actor_id',
            scope.actorId,
          )
        ).rows.length === 1
      );
    },
  };
  const configure = (configured: ProviderOptions, arm: string) => {
    const proposals = configured.hostOptions.proposals;
    if (!proposals) throw Error('Missing feedback proposal configuration');
    return {
      ...configured.hostOptions,
      ...(arm === 'baseline' ? {} : { feedback }),
      proposals: {
        ...proposals,
        version: protocol.catalog.configurationVersion,
        promptVersion: protocol.catalog.promptVersion,
        limits: {
          ...proposals.limits,
          maxCandidates: protocol.catalog.maximumCandidates,
        },
      },
    };
  };
  mkdirSync(input.artifactsRoot, { recursive: false });
  const sharedRoot = join(input.artifactsRoot, 'shared');
  mkdirSync(sharedRoot);
  const first = await input.createProviders(makeItem(manifest.cases[0]));
  const initial = await ReferenceReviewHost.provision(
    sharedRoot,
    configure(first, 'training'),
  );
  const candidateIds: Record<string, string> = {};
  const trainingFeedback = new Set<string>();
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    const contents = await Contents.create({ db: initial.db });
    const subtypeField = '_meta_type';
    for (const candidate of candidates) {
      const record = await contents.create({
        [subtypeField]: DOCUMENT,
        tenantId: EVALUATION_SCOPE.tenantId,
        context: EVALUATION_SCOPE.confidentialScopeId,
        title: candidate.title,
        body: 'Synthetic feedback target',
        status: 'draft',
      });
      if (!record.id) throw Error('Missing candidate ID');
      candidateIds[candidate.id] = record.id;
    }
    for (const [index, row] of manifest.cases.entries()) {
      const configured =
        index === 0 ? first : await input.createProviders(makeItem(row));
      const hostOptions = configure(configured, row.arm);
      const result = await runReferenceCase({
        item: makeItem(row),
        corpusRoot: input.materializationRoot,
        artifactsRoot: input.artifactsRoot,
        manifestSha256: input.expectedManifestSha256,
        capturedAt: new Date().toISOString(),
        hostOptions,
        modelWasInvoked: configured.modelWasInvoked,
        sharedRuntime: { db: initial.db, root: sharedRoot, candidateIds },
      });
      const references =
        result.view.generation?.provenance.feedback?.selection.examples ?? [];
      if (
        references.some(
          (reference) => !trainingFeedback.has(reference.feedbackId),
        )
      )
        throw Error('Non-training feedback reached provider');
      let correction:
        | Awaited<ReturnType<typeof recordTrainingCorrection>>
        | undefined;
      if (row.arm === 'training') {
        const host = new ReferenceReviewHost(
          initial.db,
          sharedRoot,
          hostOptions,
        );
        correction = await recordTrainingCorrection(
          host,
          result.view,
          row.expectedTarget,
          candidateIds,
        );
        if (correction.available && correction.feedback)
          trainingFeedback.add(correction.feedback.id);
      }
      const prediction = result.prediction;
      const success =
        prediction.status === 'completed' &&
        (row.expectedTarget === null
          ? prediction.abstained
          : prediction.actions.length === 1 &&
            prediction.actions[0].kind === 'attachment' &&
            prediction.actions[0].target === row.expectedTarget);
      const outcome = {
        id: row.id,
        family: row.family,
        arm: row.arm,
        expectedTarget: row.expectedTarget,
        success,
        prediction,
        correction: correction ?? null,
        eligibleExamples: references.length,
        feedbackReferences: references,
        identityDigest: result.identityDigest,
      };
      outcomes.push(outcome);
      writeFileSync(
        join(input.artifactsRoot, row.id, 'feedback-outcome.json'),
        JSON.stringify(outcome),
        { flag: 'wx', mode: 0o600 },
      );
    }
    const report = {
      protocolSha256: manifest.protocolSha256,
      manifestSha256: input.expectedManifestSha256,
      outcomes,
      trainingExampleCount: trainingFeedback.size,
      pairedFamilies: 4,
      independentHumanReview: false,
      improvementGuarantee: false,
      automaticActionEligible: false,
    };
    writeFileSync(
      join(input.artifactsRoot, 'feedback-report.json'),
      JSON.stringify(report),
      { flag: 'wx', mode: 0o600 },
    );
    return report;
  } finally {
    ReferenceReviewWorker.host = undefined;
    await initial.db.close?.();
  }
}

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contents } from '@happyvertical/smrt-content';
import type { DatabaseInterface } from '@happyvertical/sql';
import { DOCUMENT } from '../reference/handlers.js';
import {
  REVIEW_TENANT,
  ReferenceReviewHost,
  type ReferenceReviewHostOptions,
  ReferenceReviewWorker,
} from '../reference/review-host.js';
import type { ProposalGenerator } from '../src/proposal-contracts.js';
import type { GeneratedSuggestion } from '../src/proposal-dto.js';
import {
  type CaseObservations,
  type ReviewStage,
  retainObservations,
  retainProjection,
} from './case-observation.js';
import {
  caseUploadRequest,
  type FrozenCaseSource,
  opaqueCaptureId,
  readFrozenSource,
} from './case-source.js';
import { type CaseIdentityMap, freezeCaseIdentity } from './identity-map.js';
import { projectGeneration } from './prediction.js';

export interface ReferenceCase {
  id: string;
  lane: 'provider-quality' | 'deterministic-fault';
  sources: FrozenCaseSource[];
  candidates: Array<{ id: string; title: string }>;
  fixtureContext: {
    hiddenTargets: Array<{
      id: string;
      title: string;
      visibility: 'different-tenant' | 'different-confidential-scope';
    }>;
  };
}
export const EVALUATION_SCOPE = Object.freeze({
  actorId: 'owner',
  tenantId: REVIEW_TENANT,
  confidentialScopeId: 'private',
});
/** One isolated maintained consumer per case. No expected labels are accepted. */
export async function runReferenceCase(input: {
  item: ReferenceCase;
  corpusRoot: string;
  artifactsRoot: string;
  manifestSha256: string;
  capturedAt: string;
  hostOptions: ReferenceReviewHostOptions;
  modelWasInvoked: () => boolean;
  sharedRuntime?: {
    db: DatabaseInterface;
    root: string;
    candidateIds: Record<string, string>;
  };
  reviewSuggestion?: (
    suggestion: GeneratedSuggestion,
    mapping: CaseIdentityMap,
  ) => 'approve' | 'reject';
}) {
  const { item } = input;
  if (!/^[a-z0-9-]+$/.test(item.id)) throw Error('Invalid frozen case ID');
  if (
    item.sources.length !== 1 ||
    !input.hostOptions.proposals?.generator ||
    !input.hostOptions.extraction
  )
    throw Error(
      'Case requires one frozen source and explicit owning providers',
    );
  const root = join(input.artifactsRoot, item.id);
  mkdirSync(root, { recursive: false });
  const source = item.sources[0];
  const bytes = readFrozenSource(input.corpusRoot, source);
  const captureId = opaqueCaptureId(item.id);
  writeFileSync(
    join(root, 'capture-identity.json'),
    JSON.stringify({ caseId: item.id, captureId, source }),
    { flag: 'wx', mode: 0o600 },
  );
  const entries: CaseIdentityMap['entries'] = [];
  let identity: CaseIdentityMap | undefined, identityDigest: string | undefined;
  let explicitModelAbstention = false;
  const generator = input.hostOptions.proposals.generator;
  const observed: ProposalGenerator = {
    identity: generator.identity,
    generate: async (request, options) => {
      if (!identity || !identityDigest)
        throw Error('Identity not frozen before provider');
      if (item.lane !== 'provider-quality')
        throw Error('Frozen deterministic fault forbids inference');
      const result = await generator.generate(request, options);
      const value = result.output as {
        outcome?: unknown;
        suggestions?: unknown;
      };
      explicitModelAbstention =
        !!value &&
        ['no_action', 'unknown', 'ambiguous'].includes(String(value.outcome)) &&
        Array.isArray(value.suggestions) &&
        value.suggestions.length === 0;
      writeFileSync(join(root, 'raw-generation.json'), JSON.stringify(result), {
        flag: 'wx',
        mode: 0o600,
      });
      return result;
    },
  };
  const extraction = input.hostOptions.extraction;
  const options: ReferenceReviewHostOptions = {
    ...input.hostOptions,
    proposals: { ...input.hostOptions.proposals, generator: observed },
    extraction: {
      ...extraction,
      run: async (service, lease) => {
        const snapshot = await service.getAnalysisInput(lease);
        const original = snapshot.evidence.filter(
          (part) =>
            part.contentHash === source.sha256 &&
            part.mediaType === source.mediaType &&
            part.byteLength === source.byteLength,
        );
        if (original.length !== 1)
          throw Error('Original source not retained exactly');
        entries.push({
          logical: `evidence-${item.id}`,
          actual: original[0].id,
        });
        identity = {
          caseId: item.id,
          corpusManifestSha256: input.manifestSha256,
          entries,
        };
        identityDigest = freezeCaseIdentity(
          join(root, 'identity.json'),
          identity,
        );
        writeFileSync(
          join(root, 'source-receipt.json'),
          JSON.stringify({
            itemId: lease.itemId,
            attemptId: lease.attemptId,
            evidence: snapshot.evidence,
            identityDigest,
          }),
          { flag: 'wx', mode: 0o600 },
        );
        await extraction.run(service, lease);
      },
    },
  };
  const host = input.sharedRuntime
    ? new ReferenceReviewHost(
        input.sharedRuntime.db,
        input.sharedRuntime.root,
        options,
      )
    : await ReferenceReviewHost.provision(root, options);
  ReferenceReviewWorker.host = host;
  try {
    const contents = await Contents.create({ db: host.db });
    const subtypeField = '_meta_type';
    for (const candidate of item.candidates) {
      const record = input.sharedRuntime
        ? await contents.get({
            id: input.sharedRuntime.candidateIds[candidate.id],
          })
        : await contents.create({
            [subtypeField]: DOCUMENT,
            tenantId: REVIEW_TENANT,
            context: 'private',
            title: candidate.title,
            body: 'Synthetic evaluation target',
            status: 'draft',
          });
      if (
        !record?.id ||
        record.title !== candidate.title ||
        record.tenantId !== EVALUATION_SCOPE.tenantId ||
        record.context !== EVALUATION_SCOPE.confidentialScopeId
      )
        throw Error('Shared candidate changed');
      entries.push({ logical: candidate.id, actual: record.id });
    }
    for (const hidden of item.fixtureContext.hiddenTargets) {
      const record = await contents.create({
        [subtypeField]: DOCUMENT,
        tenantId:
          hidden.visibility === 'different-tenant'
            ? '33333333-3333-4333-8333-333333333333'
            : REVIEW_TENANT,
        context:
          hidden.visibility === 'different-confidential-scope'
            ? 'hidden'
            : 'private',
        title: hidden.title,
        body: 'Synthetic hidden target',
        status: 'draft',
      });
      entries.push({ logical: hidden.id, actual: String(record.id) });
    }
    const started = performance.now();
    const received = await host.upload(
      EVALUATION_SCOPE,
      caseUploadRequest(source, bytes, captureId, input.capturedAt),
    );
    const view = await host.load(EVALUATION_SCOPE, received.itemId);
    const suggestionLatencyMs = performance.now() - started;
    const modelInvoked = input.modelWasInvoked();
    const prediction =
      view.generation && identity
        ? projectGeneration(
            item.id,
            view.generation,
            identity,
            modelInvoked,
            explicitModelAbstention,
          )
        : {
            id: item.id,
            status: 'provider_failure',
            modelInvoked,
            actions: [],
            abstained: false,
          };
    retainProjection(root, { ...prediction, latencyMs: suggestionLatencyMs });
    const observations: CaseObservations = {
      reviewOutcome: { status: 'not_requested', stage: 'not_started' },
      safety: {},
    };
    retainObservations(root, observations);
    let stage: ReviewStage = 'not_started';
    let reason: NonNullable<CaseObservations['reviewOutcome']['reason']> =
      'operation_failed';
    let reloaded: typeof view | null = null;
    const effects: Array<Record<string, unknown>> = [];
    try {
      if (view.reviews.actions.length) {
        reason = 'unexpected_preexisting_action';
        throw Error('Unexpected action before scripted review');
      }
      if (
        input.reviewSuggestion &&
        view.generation &&
        view.analysis &&
        identity
      ) {
        for (const [
          index,
          suggestion,
        ] of view.generation.suggestions.entries()) {
          if (suggestion.disposition !== 'ready_for_review') continue;
          stage = 'preview';
          const previews = await host.preview(EVALUATION_SCOPE, {
            itemId: received.itemId,
            attemptId: view.analysis.attemptId,
            index,
            requestId: `evaluation-preview:${index}`,
          });
          if (previews.length !== 1 || previews[0].kind !== 'operation') {
            reason = 'unexpected_preview';
            throw Error('Unexpected reference preview');
          }
          const review = previews[0].review;
          stage = 'decision';
          const decision = input.reviewSuggestion(suggestion, identity);
          await host.decide(
            { ...EVALUATION_SCOPE, actorId: 'reviewer' },
            {
              actionId: review.actionId,
              expectedRevision: review.revision,
              expectedReviewVersion: review.reviewVersion,
              bindingHash: review.bindingHash,
              requestId: `evaluation-review:${index}`,
              decision,
              reason:
                'Scripted authenticated evaluation review; agent-authored frozen oracle, not observed human review',
            },
          );
          if (decision === 'approve') {
            stage = 'apply';
            const { service } = await host.service(EVALUATION_SCOPE);
            const applied = await service.applyAction(review.actionId);
            const effect: Record<string, unknown> = {
              index,
              decision,
              applied,
              reviewer: 'scripted-authenticated',
            };
            effects.push(effect);
            stage = 'effect_verification';
            const domainSnapshot = async () => {
              const record = await contents.get({
                id: String(applied.result?.contentId),
              });
              if (!record) throw Error('Reference effect content missing');
              return {
                contents: await contents.count({
                  where: {
                    tenantId: EVALUATION_SCOPE.tenantId,
                    context: EVALUATION_SCOPE.confidentialScopeId,
                  },
                }),
                content: await host.result(EVALUATION_SCOPE, record.id!),
                assets: (await record.getAssets())
                  .map((asset) => asset.id)
                  .sort(),
              };
            };
            const domainBeforeReplay = await domainSnapshot();
            stage = 'replay';
            const replay = await service.applyAction(review.actionId);
            stage = 'effect_verification';
            const domainAfterReplay = await domainSnapshot();
            if (
              JSON.stringify(domainBeforeReplay) !==
              JSON.stringify(domainAfterReplay)
            ) {
              observations.safety.duplicateEffects =
                (observations.safety.duplicateEffects ?? 0) + 1;
              retainObservations(root, observations);
              reason = 'duplicate_effect';
              throw Error('Duplicate reference domain effect');
            }
            if (
              applied.state !== 'succeeded' ||
              JSON.stringify(applied) !== JSON.stringify(replay)
            ) {
              reason = 'effect_mismatch';
              throw Error('Reference effect or idempotent replay failed');
            }
            Object.assign(effect, {
              index,
              decision,
              applied,
              replay,
              reviewer: 'scripted-authenticated',
              domain: domainAfterReplay,
            });
          } else
            effects.push({
              index,
              decision,
              reviewer: 'scripted-authenticated',
            });
        }
      }
      stage = 'reload';
      reloaded = await host.load(EVALUATION_SCOPE, received.itemId);
      observations.reviewOutcome = {
        status: input.reviewSuggestion ? 'completed' : 'not_requested',
        stage,
      };
    } catch {
      observations.reviewOutcome = { status: 'failed', stage, reason };
    }
    retainObservations(root, observations);
    const receipt = {
      prediction: {
        ...prediction,
        latencyMs: suggestionLatencyMs,
        ...observations,
      },
      itemId: received.itemId,
      identityDigest,
      view,
      effects,
      scriptedReviewAndEffectMs:
        performance.now() - started - suggestionLatencyMs,
      reloaded,
      automaticActionEligible: false,
    };
    writeFileSync(join(root, 'case-result.json'), JSON.stringify(receipt), {
      flag: 'wx',
      mode: 0o600,
    });
    return receipt;
  } finally {
    if (ReferenceReviewWorker.host === host)
      ReferenceReviewWorker.host = undefined;
    if (!input.sharedRuntime) await host.db.close?.();
  }
}

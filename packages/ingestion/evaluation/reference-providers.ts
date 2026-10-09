import { getAI } from '@happyvertical/ai';
import type { ReferenceReviewHostOptions } from '../reference/review-host.js';
import {
  createSDKExtractionAdapter,
  type ExtractionSDKConfiguration,
  extractAnalysis,
} from '../src/extraction.js';
import { createSDKProposalGenerator } from '../src/proposal-sdk.js';
import {
  assertProviderEndpoint,
  createBudgetedProposalChat,
  PROPOSAL_BOUND,
} from './bounded-chat.mjs';
import { budgetExtractionAdapter } from './bounded-extraction.js';
import type { BudgetLedger } from './budget.mjs';
import { assertNativeScope } from './native-scope.mjs';
import type { ReferenceCase } from './reference-case.js';

export const REFERENCE_EXTRACTION = Object.freeze({
  configurationRevision: 'evaluation-extraction-v1',
  limits: Object.freeze({
    maxBytes: 1000000,
    maxPages: 10,
    maxPixels: 1000000,
    maxOutputBytes: 100000,
    timeoutMs: 30000,
    maxTokens: 1024,
    workerHeapMb: 256,
  }),
});
/** PDF/text runs never receive paid provider configuration, even with host credentials.
 * This prevents the owning empty-text PDF rendering path from invoking OCR. */
export function referenceExtractionConfiguration(input: {
  item: ReferenceCase;
  apiKey: string;
  baseUrl: string;
}): ExtractionSDKConfiguration {
  assertProviderEndpoint(input.baseUrl);
  const local = {
    nativeMemoryIsolation: 'host-enforced' as const,
    maxConcurrentProcesses: 1,
    pdf: {
      provider: 'unpdf' as const,
      identity: {
        provider: 'unpdf',
        model: 'embedded-text',
        version: '0.65.9',
      },
    },
  };
  return input.item.lane === 'deterministic-fault' ||
    !input.item.sources.some((source) =>
      ['image/png', 'audio/wav'].includes(source.mediaType),
    )
    ? local
    : {
        ...local,
        imageMode: 'ocr',
        ocr: {
          identity: {
            provider: 'litellm',
            model: PROPOSAL_BOUND.model,
            version: '0.61.6',
          },
          options: {
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            model: PROPOSAL_BOUND.model,
            outputMode: 'simple',
            timeout: 30000,
          },
        },
        speech: {
          identity: {
            provider: 'openai-compatible',
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            version: '0.102.7',
          },
          options: {
            type: 'openai-compatible',
            baseUrl: input.baseUrl,
            apiKey: input.apiKey,
            model: 'gpt-4o-mini-transcribe-2025-12-15',
            retry: false,
            responseFormat: 'json',
          },
        },
      };
}

/** Trusted runner construction. The live launcher pins the official endpoint and
 * canonical ledger; local integration tests supply loopback transport/temporary ledger.
 * Native controls are checked before any SDK client is constructed.
 */
export async function createReferenceProviderOptions(input: {
  item: ReferenceCase;
  ledger: BudgetLedger;
  runHash: string;
  profileDigest: string;
  apiKey: string;
  baseUrl: string;
  cohort?: 'heldout' | 'feedback';
}) {
  assertProviderEndpoint(input.baseUrl);
  const nativeScope = assertNativeScope();
  if (
    !input.apiKey ||
    !/^[a-f0-9]{64}$/.test(input.runHash) ||
    !/^[a-f0-9]{64}$/.test(input.profileDigest)
  )
    throw Error('Invalid frozen provider construction');
  const sdk = await getAI({
    type: 'openai',
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    defaultModel: PROPOSAL_BOUND.model,
    maxRetries: 0,
  });
  let modelInvoked = false;
  const observed = {
    chat: async (...args: Parameters<typeof sdk.chat>) => {
      modelInvoked = true;
      return sdk.chat(...args);
    },
  };
  const chat = createBudgetedProposalChat(
    input.ledger,
    {
      callId: `${input.cohort ?? 'heldout'}:${input.item.id}:generation`,
      runHash: input.runHash,
    },
    observed,
  );
  const generator = createSDKProposalGenerator(
    chat,
    { provider: 'openai', model: PROPOSAL_BOUND.model, version: '0.102.7' },
    { maxTokens: 1024, timeoutMs: 30000 },
  );
  const adapter = createSDKExtractionAdapter(
    referenceExtractionConfiguration(input),
  );
  const hostOptions: ReferenceReviewHostOptions = {
    proposalPolicy: {
      version: 'evaluation-policy-v1',
      providers: ['openai'],
      maxBytes: 20000,
      leaseMs: 120000,
    },
    proposals: {
      version: 'evaluation-generator-v1',
      promptVersion: 'evaluation-owning-prompt-v1',
      limits: {
        maxHandlers: 2,
        maxCandidates: 4,
        maxSuggestions: 2,
        maxInputBytes: 8192,
        maxOutputBytes: 20000,
        maxQueryLength: 1000,
        timeoutMs: 30000,
      },
      generator,
    },
    extraction: {
      configuration: REFERENCE_EXTRACTION,
      run: async (service, lease) => {
        const snapshot = await service.getAnalysisInput(lease);
        const frozenParts = new Map(
          snapshot.evidence.map((part) => [
            part.id,
            {
              sha256: part.contentHash,
              mediaType: part.mediaType,
              byteLength: part.byteLength,
            },
          ]),
        );
        return extractAnalysis(
          service,
          lease,
          {
            extract: async (request) => {
              if (input.item.lane === 'deterministic-fault')
                return adapter.extract(request);
              const source = frozenParts.get(request.evidence.id);
              if (!source) throw Error('Unfrozen extraction source');
              const original = input.item.sources.find(
                (part) => part.sha256 === source.sha256,
              );
              if (!original && source.mediaType !== 'application/json')
                throw Error('Unexpected transport evidence');
              const durationSeconds = original?.durationSeconds;
              return budgetExtractionAdapter(adapter, input.ledger, {
                callId: `${input.cohort ?? 'heldout'}:${input.item.id}:${source.sha256}:extraction`,
                runHash: input.runHash,
                profileDigest: input.profileDigest,
                source: {
                  ...source,
                  ...(durationSeconds === undefined ? {} : { durationSeconds }),
                },
                ...REFERENCE_EXTRACTION,
              }).extract(request);
            },
          },
          REFERENCE_EXTRACTION,
        );
      },
    },
  };
  return { hostOptions, nativeScope, modelWasInvoked: () => modelInvoked };
}

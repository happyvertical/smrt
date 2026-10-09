import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { ATTACH, CREATE } from '../reference/handlers.js';
import { extractAnalysis } from '../src/extraction.js';
import { extractWithProviders } from '../src/extraction-providers.js';
import { runReferenceCase } from './reference-case.js';

test.each([
  'none',
  'draft',
  'attachment',
] as const)('maintained case %s freezes identity and proves scripted review/effect/replay', async (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-case-'));
  const corpus = join(root, 'corpus'),
    artifacts = join(root, 'artifacts');
  mkdirSync(corpus);
  mkdirSync(artifacts);
  const bytes = Buffer.from('No supported action is requested.');
  writeFileSync(join(corpus, 'source.txt'), bytes);
  const configuration = {
    configurationRevision: 'case-test1',
    limits: {
      maxBytes: 1000000,
      maxPages: 10,
      maxPixels: 1000000,
      maxOutputBytes: 100000,
      timeoutMs: 15000,
      maxTokens: 1024,
      workerHeapMb: 256,
    },
  };
  let invoked = false;
  try {
    const result = await runReferenceCase({
      item: {
        id: 'case-contract',
        lane: 'provider-quality',
        candidates:
          kind === 'attachment'
            ? [{ id: 'target', title: 'Synthetic target' }]
            : [],
        fixtureContext: { hiddenTargets: [] },
        sources: [
          {
            path: 'source.txt',
            mediaType: 'text/plain',
            byteLength: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        ],
      },
      corpusRoot: corpus,
      artifactsRoot: artifacts,
      manifestSha256: 'a'.repeat(64),
      capturedAt: new Date().toISOString(),
      modelWasInvoked: () => invoked,
      reviewSuggestion: () => 'approve',
      hostOptions: {
        proposalPolicy: {
          version: 'case-policy1',
          providers: ['fixture'],
          maxBytes: 20000,
          leaseMs: 60000,
        },
        proposals: {
          version: 'case-config1',
          promptVersion: 'case-prompt1',
          limits: {
            maxHandlers: 2,
            maxCandidates: 4,
            maxSuggestions: 2,
            maxInputBytes: 20000,
            maxOutputBytes: 20000,
            maxQueryLength: 1000,
            timeoutMs: 10000,
          },
          generator: {
            identity: {
              provider: 'fixture',
              model: 'no-inference',
              version: '1',
            },
            generate: async (input) => {
              const identity = JSON.parse(
                readFileSync(
                  join(artifacts, 'case-contract', 'identity.json'),
                  'utf8',
                ),
              );
              expect(identity.entries).toHaveLength(
                kind === 'attachment' ? 2 : 1,
              );
              invoked = true;
              return {
                completion: 'complete',
                output:
                  kind === 'none'
                    ? { outcome: 'no_action', suggestions: [], splits: [] }
                    : {
                        outcome: 'proposals',
                        splits: [],
                        suggestions: [
                          {
                            handlerId: kind === 'draft' ? CREATE : ATTACH,
                            handlerVersion: '1',
                            args:
                              kind === 'draft'
                                ? {
                                    title: 'Synthetic draft',
                                    body: 'Retained source',
                                  }
                                : {
                                    contentId: input.offered.find(
                                      (entry) => entry.handler.id === ATTACH,
                                    )!.candidates[0].id,
                                    evidenceId: input.evidence[0].evidenceId,
                                  },
                            evidence: [
                              {
                                evidenceId: input.evidence[0].evidenceId,
                                location:
                                  input.evidence[0].segments[0].location,
                              },
                            ],
                            alternatives: [],
                            missingFields: [],
                            explanation:
                              'Injected boundary fixture, not measured quality',
                          },
                        ],
                      },
              };
            },
          },
        },
        extraction: {
          configuration,
          run: (service, lease) =>
            extractAnalysis(
              service,
              lease,
              { extract: (request) => extractWithProviders(request, {}) },
              configuration,
            ),
        },
      },
    });
    expect(result.prediction).toMatchObject({
      status: 'completed',
      abstained: kind === 'none',
      modelInvoked: true,
    });
    expect(result.view.reviews.actions).toEqual([]);
    expect(result.effects).toHaveLength(kind === 'none' ? 0 : 1);
    if (kind !== 'none')
      expect(result.reloaded.reviews.actions[0].review.state).toBe('succeeded');
    expect(result.identityDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      JSON.parse(
        readFileSync(
          join(artifacts, 'case-contract', 'case-result.json'),
          'utf8',
        ),
      ).itemId,
    ).toBe(result.itemId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

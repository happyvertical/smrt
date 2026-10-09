/** Explicit native-provider lane: run inside the documented2GiB/swap0 scope. No paid endpoints. */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { expect, test, vi } from 'vitest';
import type { createSDKExtractionAdapter as AdapterFactory } from '../src/extraction.js';
import { extractionRequest } from '../src/test-support/extraction-fixtures.js';
import {
  budgetExtractionAdapter,
  type FrozenExtractionCall,
} from './bounded-extraction.js';
import { BudgetLedger } from './budget.mjs';
import { assertNativeScope } from './native-scope.mjs';

test('real built OCR child cannot send before authority/reservation or repeat a retained paid identity', async () => {
  const scope = assertNativeScope();
  expect(scope.maximumBytes).toBe(2147483648);
  const module = await import(
    /* @vite-ignore */ pathToFileURL(resolve('dist/server.js')).href
  );
  const create = module.createSDKExtractionAdapter as typeof AdapterFactory;
  const root = mkdtempSync(join(tmpdir(), 'evaluation-child-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  let calls = 0,
    authorized = false,
    status = 200;
  const observations: Array<{ authorized: boolean; charged: number }> = [];
  const server = createServer(async (request, response) => {
    calls++;
    observations.push({ authorized, charged: ledger.snapshot().charged });
    for await (const _chunk of request) {
      /* Drain the complete owning SDK body. */
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'child-fixture',
        model: 'gpt-5.4-mini-2026-03-17',
        choices: [
          JSON.parse(
            '{"index":0,"message":{"role":"assistant","content":"actual local child OCR transport"},"finish_reason":"stop"}',
          ),
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  try {
    const adapter = create({
      nativeMemoryIsolation: 'host-enforced',
      maxConcurrentProcesses: 1,
      imageMode: 'ocr',
      ocr: {
        identity: {
          provider: 'litellm',
          model: 'gpt-5.4-mini-2026-03-17',
          version: '0.61.6',
        },
        options: {
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'local-non-secret-fixture',
          model: 'gpt-5.4-mini-2026-03-17',
          outputMode: 'simple',
          timeout: 5000,
        },
      },
    });
    const image = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const request = extractionRequest(image, 'image/png');
    request.limits.timeoutMs = 15000;
    request.beforeProviderCall = async () => {
      if (!authorized) throw Error('Revoked');
    };
    const frozen: FrozenExtractionCall = {
      callId: 'case:actual-child',
      runHash: 'a'.repeat(64),
      profileDigest: 'b'.repeat(64),
      source: {
        sha256: request.evidence.contentHash,
        mediaType: 'image/png',
        byteLength: image.length,
      },
      configurationRevision: request.configurationRevision,
      limits: request.limits,
    };
    const bounded = budgetExtractionAdapter(adapter, ledger, frozen);
    const denied = await bounded.extract(request);
    expect(denied.status).toBe('failed');
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
    authorized = true;
    const result = await bounded.extract(request);
    expect(
      result.status,
      JSON.stringify({
        errors: result.errors,
        calls,
        charged: ledger.snapshot().charged,
      }),
    ).toBe('complete');
    expect(result.segments[0].text).toBe('actual local child OCR transport');
    expect(calls).toBe(1);
    expect(ledger.snapshot().unknownChargeCalls).toBe(1);
    expect(observations).toEqual([{ authorized: true, charged: 22810500 }]);
    const repeated = await budgetExtractionAdapter(
      adapter,
      ledger,
      frozen,
    ).extract(request);
    expect(repeated.status).toBe('failed');
    expect(calls).toBe(1);
    expect(ledger.snapshot().charged).toBe(22810500);
    status = 502;
    const failureIdentity = { ...frozen, callId: 'case:actual-child-error' };
    const failed = await budgetExtractionAdapter(
      adapter,
      ledger,
      failureIdentity,
    ).extract(request);
    expect(failed.status).toBe('failed');
    expect(calls).toBe(2);
    expect(ledger.snapshot().charged).toBe(45621000);
    const failureReplay = await budgetExtractionAdapter(
      adapter,
      ledger,
      failureIdentity,
    ).extract(request);
    expect(failureReplay.status).toBe('failed');
    expect(calls).toBe(2);
    expect(ledger.snapshot().charged).toBe(45621000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('real speech child reserves before its single HTTP call and retains failure/restart exposure', async () => {
  assertNativeScope();
  const module = await import(
    /* @vite-ignore */ pathToFileURL(resolve('dist/server.js')).href
  );
  const create = module.createSDKExtractionAdapter as typeof AdapterFactory;
  const root = mkdtempSync(join(tmpdir(), 'evaluation-speech-child-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  let calls = 0,
    authorized = false,
    gates = 0,
    status = 200;
  const observations: number[] = [];
  const server = createServer(async (request, response) => {
    calls++;
    observations.push(ledger.snapshot().charged);
    for await (const _chunk of request) {
      /* Drain SDK multipart body. */
    }
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(
        status === 200
          ? { text: 'actual speech child transport' }
          : { error: { message: 'local failure' } },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  try {
    const model = 'gpt-4o-mini-transcribe-2025-12-15';
    const adapter = create({
      nativeMemoryIsolation: 'host-enforced',
      maxConcurrentProcesses: 1,
      speech: {
        identity: { provider: 'openai-compatible', model, version: '0.102.4' },
        options: {
          type: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'local-non-secret-fixture',
          model,
          retry: false,
          responseFormat: 'json',
        },
      },
    });
    const bytes = Buffer.alloc(32044);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(bytes.length - 8, 4);
    bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(16000, 24);
    bytes.writeUInt32LE(32000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36);
    bytes.writeUInt32LE(32000, 40);
    const request = extractionRequest(bytes, 'audio/wav');
    request.limits.timeoutMs = 15000;
    request.beforeProviderCall = async () => {
      gates++;
      if (!authorized) throw Error('Revoked');
    };
    const frozen: FrozenExtractionCall = {
      callId: 'speech:actual-child',
      runHash: 'a'.repeat(64),
      profileDigest: 'b'.repeat(64),
      source: {
        sha256: request.evidence.contentHash,
        mediaType: 'audio/wav',
        byteLength: bytes.length,
        durationSeconds: 1,
      },
      configurationRevision: request.configurationRevision,
      limits: request.limits,
    };
    expect(
      (await budgetExtractionAdapter(adapter, ledger, frozen).extract(request))
        .status,
    ).toBe('failed');
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
    authorized = true;
    gates = 0;
    const result = await budgetExtractionAdapter(
      adapter,
      ledger,
      frozen,
    ).extract(request);
    expect(result.status, JSON.stringify(result.errors)).toBe('complete');
    expect(result.segments[0].text).toBe('actual speech child transport');
    expect(gates).toBe(1);
    expect(calls).toBe(1);
    expect(observations).toEqual([30000000]);
    expect(
      (await budgetExtractionAdapter(adapter, ledger, frozen).extract(request))
        .status,
    ).toBe('failed');
    expect(calls).toBe(1);
    status = 502;
    expect(
      (
        await budgetExtractionAdapter(adapter, ledger, {
          ...frozen,
          callId: 'speech:failure',
        }).extract(request)
      ).status,
    ).toBe('failed');
    expect(calls).toBe(2);
    expect(observations).toEqual([30000000, 60000000]);
    expect(ledger.snapshot().charged).toBe(60000000);
    expect(ledger.snapshot().unknownChargeCalls).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('maintained image upload uses the frozen provider factory through OCR then bounded proposal with durable provenance', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { createReferenceProviderOptions } = await import(
    './reference-providers.js'
  );
  const { runReferenceCase } = await import('./reference-case.js');
  const root = mkdtempSync(join(tmpdir(), 'evaluation-full-native-'));
  const corpus = join(root, 'corpus'),
    artifacts = join(root, 'artifacts');
  mkdirSync(corpus);
  mkdirSync(artifacts);
  const ledger = new BudgetLedger(join(root, 'budget.sqlite'));
  const bytes = await sharp({
    create: { width: 1000, height: 1000, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  writeFileSync(join(corpus, 'source.png'), bytes);
  const wire: Array<{
    vision: boolean;
    charged: number;
    bytes: number;
    body: string;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const vision = body.includes('data:image/');
    wire.push({
      vision,
      body,
      charged: ledger.snapshot().charged,
      bytes: Buffer.byteLength(body),
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'composed-native',
        model: 'gpt-5.4-mini-2026-03-17',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: vision
                ? 'No supported action.'
                : JSON.stringify({
                    outcome: 'no_action',
                    suggestions: [],
                    splits: [],
                  }),
            },
            ...JSON.parse('{"finish_reason":"stop"}'),
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  try {
    const item = {
      id: 'credential-exfiltration-01',
      lane: 'provider-quality' as const,
      candidates: [],
      fixtureContext: { hiddenTargets: [] },
      sources: [
        {
          path: 'source.png',
          mediaType: 'image/png',
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
    const configured = await createReferenceProviderOptions({
      item,
      ledger,
      runHash: 'c'.repeat(64),
      profileDigest: 'd'.repeat(64),
      apiKey: 'local-non-secret-fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    const result = await runReferenceCase({
      item,
      corpusRoot: corpus,
      artifactsRoot: artifacts,
      manifestSha256: 'a'.repeat(64),
      capturedAt: new Date().toISOString(),
      hostOptions: configured.hostOptions,
      modelWasInvoked: configured.modelWasInvoked,
    });
    expect(result.prediction).toMatchObject({
      status: 'completed',
      abstained: true,
      modelInvoked: true,
    });
    expect(result.view.evidence).toHaveLength(2);
    expect(result.view.generation?.automaticActionEligible).toBe(false);
    expect(wire.map((row) => [row.vision, row.charged])).toEqual([
      [true, 22810500],
      [false, 33946500],
    ]);
    expect(wire[1].bytes).toBeLessThanOrEqual(8192);
    expect(wire[1].body).not.toContain('credential-exfiltration');
    const modelPayload = JSON.parse(
      JSON.parse(wire[1].body).messages[1].content,
    );
    const metadata = modelPayload.evidence.find(
      (part: { mediaType: string }) => part.mediaType === 'application/json',
    );
    expect(JSON.parse(metadata.segments[0].text).captureId).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(ledger.snapshot().unknownChargeCalls).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('scripted correction reaches a later owning SDK request and changes a deterministic suggestion without granting automation', async () => {
  const { writeFileSync, mkdirSync, readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { Contents } = await import('@happyvertical/smrt-content');
  const { ATTACH, DOCUMENT } = await import('../reference/handlers.js');
  const { ReferenceReviewHost, ReferenceReviewWorker } = await import(
    '../reference/review-host.js'
  );
  const { createReferenceProviderOptions } = await import(
    './reference-providers.js'
  );
  const { runReferenceCase, EVALUATION_SCOPE } = await import(
    './reference-case.js'
  );
  const { recordTrainingCorrection } = await import('./feedback-review.js');
  const protocol = JSON.parse(
    readFileSync(new URL('./feedback-protocol.json', import.meta.url), 'utf8'),
  );
  const root = mkdtempSync(join(tmpdir(), 'evaluation-correction-wire-'));
  const corpus = join(root, 'corpus'),
    artifacts = join(root, 'artifacts'),
    shared = join(root, 'shared');
  mkdirSync(corpus);
  mkdirSync(artifacts);
  mkdirSync(shared);
  const ledger = new BudgetLedger(join(root, 'budget.sqlite'));
  const wires: Array<{ bytes: number; examples: unknown; target: string }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const wire = JSON.parse(body);
    const payload = JSON.parse(wire.messages[1].content);
    const original = payload.evidence.find(
      (part: { mediaType: string }) => part.mediaType === 'text/plain',
    );
    const training = original.segments[0].text.includes('east');
    const target = training
      ? 'Legal East'
      : payload.examples?.examples.length
        ? 'Finance West'
        : 'Legal West';
    const catalog = payload.offered.find(
      (entry: { handler: { id: string } }) => entry.handler.id === ATTACH,
    );
    const candidate = catalog.candidates.find(
      (entry: { label: string }) => entry.label === target,
    );
    wires.push({
      bytes: Buffer.byteLength(body),
      examples: payload.examples,
      target,
    });
    // This multi-workflow fixture deliberately closes each response socket; no
    // default 5s keep-alive expiry can race the next zero-retry SDK request.
    response.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    });
    response.end(
      JSON.stringify({
        id: 'feedback-fixture',
        model: ProposalBoundModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                outcome: 'proposals',
                splits: [],
                suggestions: [
                  {
                    handlerId: ATTACH,
                    handlerVersion: '1',
                    args: {
                      contentId: candidate.id,
                      evidenceId: original.evidenceId,
                    },
                    evidence: [
                      {
                        evidenceId: original.evidenceId,
                        location: original.segments[0].location,
                      },
                    ],
                    alternatives: [],
                    missingFields: [],
                    explanation:
                      'Deterministic transport fixture, not model quality',
                  },
                ],
              }),
            },
            ...JSON.parse('{"finish_reason":"stop"}'),
          },
        ],
      }),
    );
  });
  const ProposalBoundModel = 'gpt-5.4-mini-2026-03-17';
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  const candidates = (protocol.catalog.targets as string[]).map((title) => ({
    id: title,
    title,
  }));
  const makeItem = (id: string, text: string) => {
    const bytes = Buffer.from(text);
    writeFileSync(join(corpus, `${id}.txt`), bytes);
    return {
      id,
      lane: 'provider-quality' as const,
      candidates,
      fixtureContext: { hiddenTargets: [] },
      sources: [
        {
          path: `${id}.txt`,
          mediaType: 'text/plain',
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    };
  };
  const providerErrors: string[] = [];
  const makeOptions = async (
    item: ReturnType<typeof makeItem>,
    enabled: boolean,
  ) => {
    const configured = await createReferenceProviderOptions({
      item,
      ledger,
      runHash: 'e'.repeat(64),
      profileDigest: 'f'.repeat(64),
      apiKey: 'local-non-secret-fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      cohort: 'feedback',
    });
    const proposals = configured.hostOptions.proposals;
    if (!proposals) throw Error('No proposal config');
    configured.hostOptions.proposals = {
      ...proposals,
      generator: {
        ...proposals.generator,
        generate: async (...args) => {
          try {
            return await proposals.generator.generate(...args);
          } catch (error) {
            providerErrors.push(String(error));
            throw error;
          }
        },
      },
      version: protocol.catalog.configurationVersion,
      promptVersion: protocol.catalog.promptVersion,
      limits: {
        ...proposals.limits,
        maxCandidates: protocol.catalog.maximumCandidates,
      },
    };
    if (enabled)
      configured.hostOptions.feedback = {
        ...protocol.feedbackConfiguration,
        authorize: async ({ db, scope }) =>
          (
            await db.query(
              'SELECT actor_id FROM review_grants WHERE actor_id=? AND enabled=1',
              scope.actorId,
            )
          ).rows.length === 1,
      };
    return configured;
  };
  const { evaluationDatabase } = await import('./test-database.js');
  const databaseFixture = await evaluationDatabase();
  let initial: InstanceType<typeof ReferenceReviewHost> | undefined;
  try {
    const training = makeItem(
      'feedback-training-wire',
      protocol.training[0].text,
    );
    const configured = await makeOptions(training, true);
    initial = await ReferenceReviewHost.provision(shared, {
      ...configured.hostOptions,
      database: databaseFixture.database,
    });
    const collection = await Contents.create({ db: initial.db });
    const candidateIds: Record<string, string> = {};
    const subtypeField = '_meta_type';
    for (const candidate of candidates) {
      const record = await collection.create({
        [subtypeField]: DOCUMENT,
        tenantId: EVALUATION_SCOPE.tenantId,
        context: EVALUATION_SCOPE.confidentialScopeId,
        title: candidate.title,
        body: 'Synthetic target',
        status: 'draft',
      });
      candidateIds[candidate.id] = String(record.id);
    }
    const sharedRuntime = { db: initial.db, root: shared, candidateIds };
    const first = await runReferenceCase({
      item: training,
      corpusRoot: corpus,
      artifactsRoot: artifacts,
      manifestSha256: 'a'.repeat(64),
      capturedAt: new Date().toISOString(),
      hostOptions: configured.hostOptions,
      modelWasInvoked: configured.modelWasInvoked,
      sharedRuntime,
    });
    expect(first.prediction.actions[0]).toMatchObject({ target: 'Legal East' });
    const correction = await recordTrainingCorrection(
      new ReferenceReviewHost(initial.db, shared, configured.hostOptions),
      first.view,
      'Finance East',
      candidateIds,
    );
    expect(correction).toMatchObject({ available: true, changedFields: 1 });
    for (const enabled of [false, true]) {
      const item = makeItem(
        enabled ? 'feedback-treatment-wire' : 'feedback-baseline-wire',
        protocol.pairedHeldout[0].text,
      );
      const next = await makeOptions(item, enabled);
      const result = await runReferenceCase({
        item,
        corpusRoot: corpus,
        artifactsRoot: artifacts,
        manifestSha256: 'a'.repeat(64),
        capturedAt: new Date().toISOString(),
        hostOptions: next.hostOptions,
        modelWasInvoked: next.modelWasInvoked,
        sharedRuntime,
      });
      expect(
        result.prediction.actions[0],
        JSON.stringify({
          prediction: result.prediction,
          generation: result.view.generation,
          wires,
          providerErrors,
        }),
      ).toMatchObject({
        target: enabled ? 'Finance West' : 'Legal West',
      });
      expect(result.view.generation?.automaticActionEligible).toBe(false);
      expect(result.view.reviews.actions).toEqual([]);
      expect(
        result.view.generation?.provenance.feedback?.selection.examples
          .length ?? 0,
      ).toBe(enabled ? 1 : 0);
    }
    expect(wires).toHaveLength(3);
    expect(wires.every((wire) => wire.bytes <= 8192)).toBe(true);
    expect(wires[1].examples).toBeUndefined();
    expect(wires[2].examples).toMatchObject({
      examples: [
        {
          args: { contentId: candidateIds['Finance East'] },
          judgment: 'correct',
        },
      ],
    });
    expect(ledger.snapshot().charged).toBe(33408000);
  } finally {
    ReferenceReviewWorker.host = undefined;
    await initial?.db.close?.();
    await databaseFixture.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 90000);

test('maintained WAV upload composes actual speech child, SDK proposal, authenticated review and one Content effect', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { CREATE } = await import('../reference/handlers.js');
  const { createReferenceProviderOptions } = await import(
    './reference-providers.js'
  );
  const { runReferenceCase } = await import('./reference-case.js');
  const root = mkdtempSync(join(tmpdir(), 'evaluation-audio-effect-'));
  const corpus = join(root, 'corpus'),
    artifacts = join(root, 'artifacts');
  mkdirSync(corpus);
  mkdirSync(artifacts);
  const bytes = Buffer.alloc(32044);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(32000, 40);
  writeFileSync(join(corpus, 'source.wav'), bytes);
  const ledger = new BudgetLedger(join(root, 'budget.sqlite'));
  const calls: Array<{ route: string; charged: number; bytes: number }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const speech = request.url?.endsWith('/audio/transcriptions');
    calls.push({
      route: speech ? 'speech' : 'proposal',
      charged: ledger.snapshot().charged,
      bytes: body.length,
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      connection: 'close',
    });
    if (speech) {
      response.end(
        JSON.stringify({
          text: 'Create a draft titled Audio note with body Synthetic transport.',
        }),
      );
      return;
    }
    const payload = JSON.parse(JSON.parse(body.toString()).messages[1].content);
    const original = payload.evidence.find(
      (part: { mediaType: string }) => part.mediaType === 'audio/wav',
    );
    response.end(
      JSON.stringify({
        id: 'audio-composition',
        model: 'gpt-5.4-mini-2026-03-17',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                outcome: 'proposals',
                splits: [],
                suggestions: [
                  {
                    handlerId: CREATE,
                    handlerVersion: '1',
                    args: { title: 'Audio note', body: 'Synthetic transport.' },
                    evidence: [
                      {
                        evidenceId: original.evidenceId,
                        location: original.segments[0].location,
                      },
                    ],
                    alternatives: [],
                    missingFields: [],
                    explanation:
                      'Deterministic transport fixture; not recognition quality',
                  },
                ],
              }),
            },
            ...JSON.parse('{"finish_reason":"stop"}'),
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  try {
    const item = {
      id: 'audio-effect',
      lane: 'provider-quality' as const,
      candidates: [],
      fixtureContext: { hiddenTargets: [] },
      sources: [
        {
          path: 'source.wav',
          mediaType: 'audio/wav',
          byteLength: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          durationSeconds: 1,
        },
      ],
    };
    const configured = await createReferenceProviderOptions({
      item,
      ledger,
      runHash: '1'.repeat(64),
      profileDigest: '2'.repeat(64),
      apiKey: 'local-non-secret-fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
    });
    const result = await runReferenceCase({
      item,
      corpusRoot: corpus,
      artifactsRoot: artifacts,
      manifestSha256: 'a'.repeat(64),
      capturedAt: new Date().toISOString(),
      hostOptions: configured.hostOptions,
      modelWasInvoked: configured.modelWasInvoked,
      reviewSuggestion: () => 'approve',
    });
    expect(result.prediction).toMatchObject({
      status: 'completed',
      modelInvoked: true,
      actions: [
        {
          kind: 'draft',
          fields: { title: 'Audio note', body: 'Synthetic transport.' },
        },
      ],
    });
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      decision: 'approve',
      applied: { state: 'succeeded' },
      domain: { contents: 1 },
    });
    expect(result.automaticActionEligible).toBe(false);
    expect(calls.map(({ route, charged }) => ({ route, charged }))).toEqual([
      { route: 'speech', charged: 30000000 },
      { route: 'proposal', charged: 41136000 },
    ]);
    expect(calls[1].bytes).toBeLessThanOrEqual(8192);
    expect(ledger.snapshot().unknownChargeCalls).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test('PDF empty-text fallback and text stay local with ambient provider credentials', async () => {
  assertNativeScope();
  const { readFileSync } = await import('node:fs');
  const { embeddedPDF } = await import(
    '../src/test-support/extraction-fixtures.js'
  );
  const { referenceExtractionConfiguration } = await import(
    './reference-providers.js'
  );
  const module = await import(
    /* @vite-ignore */ pathToFileURL(resolve('dist/server.js')).href
  );
  const create = module.createSDKExtractionAdapter as typeof AdapterFactory;
  const root = mkdtempSync(join(tmpdir(), 'evaluation-local-pdf-'));
  const ledger = new BudgetLedger(join(root, 'budget.sqlite'));
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    for await (const _chunk of request) {
      /* Drain any forbidden request. */
    }
    response.writeHead(502);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  vi.stubEnv('OPENAI_API_KEY', 'local-non-secret-fixture');
  vi.stubEnv('OPENAI_BASE_URL', baseUrl);
  try {
    for (const [id, bytes, mediaType] of [
      ['blank-pdf', embeddedPDF(''), 'application/pdf'],
      [
        'scanned-pdf',
        readFileSync('src/test-support/extraction-corpus/scanned.pdf'),
        'application/pdf',
      ],
      ['text', Buffer.from('Local authored text'), 'text/plain'],
    ] as const) {
      const request = extractionRequest(bytes, mediaType);
      request.limits.timeoutMs = 15000;
      let gates = 0;
      request.beforeProviderCall = async () => {
        gates++;
      };
      const source = {
        path: `source.${mediaType === 'application/pdf' ? 'pdf' : 'txt'}`,
        sha256: request.evidence.contentHash,
        byteLength: bytes.length,
        mediaType,
      };
      const configuration = referenceExtractionConfiguration({
        item: {
          id,
          lane: 'provider-quality',
          sources: [source],
          candidates: [],
          fixtureContext: { hiddenTargets: [] },
        },
        apiKey: 'local-non-secret-fixture',
        baseUrl,
      });
      const result = await budgetExtractionAdapter(
        create(configuration),
        ledger,
        {
          callId: id,
          runHash: 'a'.repeat(64),
          profileDigest: 'b'.repeat(64),
          source,
          configurationRevision: request.configurationRevision,
          limits: request.limits,
        },
      ).extract(request);
      expect(calls).toBe(0);
      expect(ledger.snapshot().charged).toBe(0);
      if (mediaType === 'application/pdf') {
        // Four owning handshakes prove the empty-text page reached renderPages.
        expect(gates).toBeGreaterThanOrEqual(4);
        expect(['unsupported', 'failed']).toContain(result.status);
        expect(result.errors.length).toBeGreaterThan(0);
      } else {
        expect(result.status).toBe('complete');
        expect(result.segments[0].text).toBe('Local authored text');
      }
      // Also fails if a future renderer makes an accidentally configured OCR reachable.
      expect(configuration.ocr).toBeUndefined();
      expect(configuration.vision).toBeUndefined();
      expect(configuration.speech).toBeUndefined();
    }
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, expect, test } from 'vitest';
import {
  REVIEW_TENANT,
  ReferenceReviewHost,
  type ReferenceReviewHostOptions,
} from '../reference/review-host.js';
import { extractAnalysis } from '../src/extraction.js';
import { extractWithProviders } from '../src/extraction-providers.js';
import type { GenerationOutput } from '../src/proposal-dto.js';
import { dropExecutionDatabase } from '../src/test-support/postgres-cleanup.js';

const scope = {
  actorId: 'owner',
  tenantId: REVIEW_TENANT,
  confidentialScopeId: 'private',
};
const extractionConfiguration = {
  configurationRevision: 'evaluation-host-contract1',
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
let root: string;
let host: ReferenceReviewHost | undefined;
let admin: DatabaseInterface | undefined;
let database: string;
async function provision(options: ReferenceReviewHostOptions) {
  root = await mkdtemp(join(tmpdir(), 'evaluation-host-'));
  if (process.env.EVALUATION_DATABASE === 'postgres') {
    const base = process.env.DATABASE_URL;
    if (!base) throw Error('PostgreSQL URL required for evaluation host proof');
    admin = await getTestDatabase({
      type: 'postgres',
      url: base,
      classes: [],
      includeSystemTables: false,
    });
    database = `exec_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE DATABASE ${database}`);
    const url = new URL(base);
    url.pathname = `/${database}`;
    options = {
      ...options,
      database: { type: 'postgres', url: url.toString() },
    };
  }
  host = await ReferenceReviewHost.provision(root, options);
  return host;
}
afterEach(async () => {
  await host?.db.close?.();
  host = undefined;
  if (admin) {
    try {
      await dropExecutionDatabase(admin, database);
    } finally {
      await admin.close?.();
      admin = undefined;
    }
  }
  if (root) await rm(root, { recursive: true, force: true });
});
function request(extra = {}) {
  return new Request('http://localhost/intake', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify({
      capturedAt: new Date().toISOString(),
      text: 'Do not create an action for this transport contract.',
      ...extra,
    }),
  });
}
function options(calls: {
  extract: number;
  generate: number;
}): ReferenceReviewHostOptions {
  return {
    proposalPolicy: {
      version: 'evaluation-policy1',
      providers: ['evaluation-fixture'],
      maxBytes: 20000,
      leaseMs: 60000,
    },
    proposals: {
      version: 'evaluation-config1',
      promptVersion: 'evaluation-prompt1',
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
          provider: 'evaluation-fixture',
          model: 'local-no-inference',
          version: '1',
        },
        generate: async () => {
          calls.generate++;
          return {
            completion: 'complete',
            output: { outcome: 'no_action', suggestions: [], splits: [] },
          };
        },
      },
    },
    extraction: {
      configuration: extractionConfiguration,
      run: async (service, lease) => {
        calls.extract++;
        // Text normalization does not invoke a native/media provider or paid endpoint.
        return extractAnalysis(
          service,
          lease,
          { extract: (request) => extractWithProviders(request, {}) },
          extractionConfiguration,
        );
      },
    },
  };
}
test('maintained host consumes trusted DB/provider/extraction settings and persists a no-action generation', async () => {
  const calls = { extract: 0, generate: 0 };
  const app = await provision(options(calls));
  const receipt = await app.upload(scope, request());
  expect(calls).toEqual({ extract: 1, generate: 1 });
  const service = (await app.service(scope)).service;
  const completed = await service.getCompletedAnalysis(receipt.itemId);
  const output = completed.result.output
    .proposals as unknown as GenerationOutput;
  expect(output).toMatchObject({
    outcome: 'no_action',
    automaticActionEligible: false,
    suggestions: [],
    provenance: {
      configurationVersion: 'evaluation-config1',
      generative: { provider: 'evaluation-fixture' },
      decision: { configured: false },
    },
  });
  expect((await service.listReviews(receipt.itemId)).actions).toEqual([]);
  const reloaded = await app.load(scope, receipt.itemId);
  expect(reloaded.generation?.outcome).toBe('no_action');
});
test('provider allowlist and authenticated scope remain owning gates with injected host settings', async () => {
  const calls = { extract: 0, generate: 0 };
  const configured = options(calls);
  configured.proposalPolicy!.providers = ['another-provider'];
  const app = await provision(configured);
  await expect(
    app.upload({ ...scope, tenantId: randomUUID() }, request()),
  ).rejects.toThrow();
  expect(calls).toEqual({ extract: 0, generate: 0 });
  await expect(
    app.upload(scope, request({ database: { url: 'untrusted' } })),
  ).rejects.toThrow();
  expect(calls).toEqual({ extract: 0, generate: 0 });
  const receipt = await app.upload(scope, request());
  expect(calls.generate).toBe(0);
  const service = (await app.service(scope)).service;
  const current = await service.getCompletedAnalysis(receipt.itemId);
  expect(current.result.output.proposals).toMatchObject({
    outcome: 'unknown',
    suggestions: [],
    offered: [],
    warnings: ['no_supported_interpretation'],
  });
  expect((await service.listReviews(receipt.itemId)).actions).toEqual([]);
});

test('real maintained-host generation envelope fits the pinned budgeted SDK request', async () => {
  const { createServer } = await import('node:http');
  const { getAI } = await import('@happyvertical/ai');
  const { createSDKProposalGenerator } = await import('../src/proposal-sdk.js');
  const { createBudgetedProposalChat, PROPOSAL_BOUND } = await import(
    './bounded-chat.mjs'
  );
  const { BudgetLedger } = await import('./budget.mjs');
  let httpCalls = 0,
    wireBytes = 0;
  const server = createServer(async (request, response) => {
    httpCalls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    wireBytes = Buffer.concat(chunks).length;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        id: 'host-envelope',
        model: PROPOSAL_BOUND.model,
        choices: [
          JSON.parse(
            '{"index":0,"message":{"role":"assistant","content":"{\\"outcome\\":\\"no_action\\",\\"suggestions\\":[],\\"splits\\":[]}"},"finish_reason":"stop"}',
          ),
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  const scratch = await mkdtemp(join(tmpdir(), 'host-envelope-'));
  const ledger = new BudgetLedger(join(scratch, 'budget.sqlite'));
  try {
    const sdk = await getAI({
      type: 'openai',
      apiKey: 'local-non-secret-fixture',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      defaultModel: PROPOSAL_BOUND.model,
      maxRetries: 0,
    });
    const client = createBudgetedProposalChat(
      ledger,
      { callId: 'host-envelope', runHash: 'c'.repeat(64) },
      sdk,
    );
    const configured = options({ extract: 0, generate: 0 });
    configured.proposalPolicy!.providers = ['openai'];
    configured.proposals!.limits.maxInputBytes = 8192;
    configured.proposals!.generator = createSDKProposalGenerator(
      client,
      { provider: 'openai', model: PROPOSAL_BOUND.model, version: '0.102.4' },
      { maxTokens: 1024, timeoutMs: 5000 },
    );
    const app = await provision(configured);
    const receipt = await app.upload(scope, request());
    expect(httpCalls).toBe(1);
    expect(wireBytes).toBeLessThanOrEqual(8192);
    expect(ledger.snapshot().charged).toBe(11136000);
    const completed = await (
      await app.service(scope)
    ).service.getCompletedAnalysis(receipt.itemId);
    expect(completed.result.output.proposals).toMatchObject({
      outcome: 'no_action',
      warnings: ['generation_completion_unknown'],
      automaticActionEligible: false,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ledger.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

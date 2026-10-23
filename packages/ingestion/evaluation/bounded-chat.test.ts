import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  assertProviderEndpoint,
  createBudgetedProposalChat,
  PROPOSAL_BOUND,
  proposalRequestBound,
} from './bounded-chat.mjs';
import { BudgetLedger } from './budget.mjs';

const options = {
  model: PROPOSAL_BOUND.model,
  maxTokens: 1024,
  toolChoice: 'none',
  continueOnLength: false,
  responseFormat: { type: 'json_object' },
};
const messages = [
  { role: 'system', content: 'Return validated JSON only.' },
  { role: 'user', content: '{}' },
];
test('whole UTF8 envelope exact ceiling passes, one byte over fails before any invocation/reservation', async () => {
  const bytes = proposalRequestBound(messages, options).serializedBytes;
  const exact = structuredClone(messages);
  exact[1].content += 'x'.repeat(PROPOSAL_BOUND.maxSerializedBytes - bytes);
  expect(proposalRequestBound(exact, options).serializedBytes).toBe(8192);
  const root = mkdtempSync(join(tmpdir(), 'evaluation-wire-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  let calls = 0;
  try {
    const client = createBudgetedProposalChat(
      ledger,
      { callId: 'one', runHash: 'a'.repeat(64) },
      {
        chat: async () => {
          calls++;
          return {
            content: 'fixture',
            usage: { promptTokens: 0, completionTokens: 0 },
          };
        },
      },
    );
    const over = structuredClone(exact);
    over[0].content += 'x';
    await expect(client.chat(over, options)).rejects.toThrow('byte ceiling');
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
    await expect(client.chat(exact, options)).resolves.toMatchObject({
      content: 'fixture',
    });
    expect(calls).toBe(1);
    expect(ledger.snapshot().charged).toBe(1_600_000);
    expect(ledger.snapshot().unknownChargeCalls).toBe(1);
    await expect(client.chat(exact, options)).rejects.toThrow(
      'already reserved',
    );
    expect(calls).toBe(1);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('unbudgeted tools, alternate models, outputs, continuation and extra context fail closed', () => {
  for (const overrides of [
    { maxTokens: 1025 },
    { model: 'other' },
    { reasoning: { effort: 'medium' } },
    { reasoning: { effort: 'none', maxTokens: 100 } },
    { tools: [{}] },
    { continueOnLength: true },
    { toolChoice: 'auto' },
    { systemPrompt: 'extra' },
    { serviceTier: 'priority' },
    JSON.parse('{"service_tier":"fast"}'),
  ])
    expect(() =>
      proposalRequestBound(messages, { ...options, ...overrides }),
    ).toThrow();
  expect(() =>
    proposalRequestBound(
      [...messages, { role: 'user', content: 'extra' }],
      options,
    ),
  ).toThrow();
  expect(() =>
    proposalRequestBound(
      [{ role: 'system', content: 'é'.repeat(8192) }, messages[1]],
      options,
    ),
  ).toThrow('byte ceiling');
});

test('caller mutation after reservation cannot enlarge the captured SDK request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-capture-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  let release!: () => void;
  const latch = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = structuredClone(messages);
  const settings = structuredClone(options);
  try {
    const client = createBudgetedProposalChat(
      ledger,
      { callId: 'capture', runHash: 'b'.repeat(64) },
      {
        chat: async (
          captured: typeof messages,
          capturedOptions: typeof options,
        ) => {
          await latch;
          expect(captured).toEqual(messages);
          expect(capturedOptions).toEqual({
            ...options,
            reasoning: { effort: 'none' },
          });
          return { content: 'captured' };
        },
      },
    );
    const pending = client.chat(input, settings);
    input[1].content = 'x'.repeat(100000);
    settings.responseFormat.type = 'unbounded';
    settings.maxTokens = 100000;
    release();
    await expect(pending).resolves.toEqual({ content: 'captured' });
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('standard global pricing rejects regional, alternate and credential-bearing endpoints', () => {
  expect(() =>
    assertProviderEndpoint('https://api.openai.com/v1'),
  ).not.toThrow();
  expect(() =>
    assertProviderEndpoint('http://127.0.0.1:12345/v1'),
  ).not.toThrow();
  for (const endpoint of [
    'https://eu.api.openai.com/v1',
    'https://api.openai.com/v1?service_tier=priority',
    'https://user:password@api.openai.com/v1',
    'https://other.example/v1',
    'http://api.openai.com/v1',
  ])
    expect(() => assertProviderEndpoint(endpoint)).toThrow(
      'Unpriced provider endpoint',
    );
});

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { outcome: { type: 'string' } },
  required: ['outcome'],
};
function schemaOptions() {
  // The owning SDK's OpenAI-shaped protocol uses snake_case field names.
  const responseFormat = JSON.parse(
    '{"type":"json_schema","json_schema":{"name":"ingestion_proposal","strict":false}}',
  );
  responseFormat.json_schema.schema = structuredClone(responseSchema);
  return {
    ...options,
    responseSchema: structuredClone(responseSchema),
    responseFormat,
  };
}
test('schema envelope counts every schema byte and rejects malformed or mismatched schema options', () => {
  const settings = schemaOptions();
  const bytes = proposalRequestBound(messages, settings).serializedBytes;
  const exact = structuredClone(messages);
  exact[1].content += 'x'.repeat(8192 - bytes);
  expect(proposalRequestBound(exact, settings).serializedBytes).toBe(8192);
  exact[1].content += 'x';
  expect(() => proposalRequestBound(exact, settings)).toThrow('byte ceiling');
  for (const overrides of [
    { responseSchema: [] },
    { responseSchema: { type: 'string' } },
    { responseFormat: { type: 'json_schema' } },
    { responseFormat: { ...settings.responseFormat, extra: 'ignored' } },
    {
      responseFormat: JSON.parse(
        '{"type":"json_schema","json_schema":{"name":"x","schema":null}}',
      ),
    },
  ])
    expect(() =>
      proposalRequestBound(messages, { ...settings, ...overrides }),
    ).toThrow();
  expect(() =>
    proposalRequestBound(messages, { ...options, responseSchema }),
  ).toThrow();
});
test('nested schema caller mutation cannot enlarge the reserved request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-schema-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  const settings = schemaOptions();
  const expected = structuredClone(settings);
  let release!: () => void;
  const latch = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const client = createBudgetedProposalChat(
      ledger,
      { callId: 'schema', runHash: 'd'.repeat(64) },
      {
        chat: async (_messages: unknown, captured: unknown) => {
          await latch;
          expect(captured).toEqual({
            ...expected,
            reasoning: { effort: 'none' },
          });
          return { content: 'captured' };
        },
      },
    );
    const pending = client.chat(structuredClone(messages), settings);
    settings.responseSchema.properties.outcome.type = 'x'.repeat(100000);
    settings.responseFormat.json_schema.schema.properties.outcome.type =
      'x'.repeat(100000);
    release();
    await expect(pending).resolves.toEqual({ content: 'captured' });
    expect(ledger.snapshot().charged).toBe(1600000);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('chat refuses unsupported caller options before normalization or reservation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-options-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  let calls = 0;
  try {
    const client = createBudgetedProposalChat(
      ledger,
      { callId: 'refused', runHash: 'e'.repeat(64) },
      {
        chat: async () => {
          calls++;
          return { content: 'unexpected' };
        },
      },
    );
    await expect(
      client.chat(messages, { ...options, reasoning: { effort: 'medium' } }),
    ).rejects.toThrow();
    await expect(
      client.chat([{ ...messages[0], name: 'extra' }, messages[1]], options),
    ).rejects.toThrow();
    const settings = schemaOptions();
    const bytes = proposalRequestBound(messages, settings).serializedBytes;
    const oversized = structuredClone(messages);
    oversized[1].content += 'x'.repeat(8193 - bytes);
    await expect(client.chat(oversized, settings)).rejects.toThrow(
      'byte ceiling',
    );
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

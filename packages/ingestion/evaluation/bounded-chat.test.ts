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

/**
 * Tests for `Journal.summarize()` — verifies the smrt-prompts integration:
 * prompt resolution, variable substitution, trimmed AI output, and that
 * internal/PII-adjacent fields (id, tenantId, sourceRef, metadata) are NOT
 * passed to the AI provider.
 *
 * The AI client is stubbed via a `getAiClient()` override so no network calls
 * are made. The `db` plumbing is exercised separately via the smrt-prompts
 * package's own integration tests; here we focus on Journal-level behavior.
 *
 * Mirrors `packages/properties/src/__tests__/summarize.test.ts`.
 */

import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../models/Journal.js';
import { smrtLedgersJournalSummarizePrompt } from '../prompts.js';

describe('Journal.summarize()', () => {
  let aiMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aiMessageMock = vi.fn().mockResolvedValue('Generated summary text  ');
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeJournal(opts: ConstructorParameters<typeof Journal>[0] = {}) {
    const journal = new Journal({
      number: 'JNL-0001',
      date: new Date('2026-05-01T00:00:00Z'),
      description: 'Cash sale of widgets',
      sourceModule: 'smrt-commerce',
      status: 'posted',
      // Internal/PII-adjacent fields that should NOT reach the AI provider:
      id: 'journal-uuid-1234',
      sourceRef: 'INV-PRIVATE-9999',
      tenantId: 'tenant-uuid-9999',
      metadata: {
        analyticsId: 'UA-PRIVATE-12345',
        secretKey: 'do-not-leak',
      },
      ...opts,
    });
    // Stub the AI client so summarize doesn't reach a real provider.
    (journal as any).getAiClient = async () => ({
      message: aiMessageMock,
    });
    // Stub aggregate helpers so we don't need a real DB for this focused test.
    (journal as any).getEntries = async () => [
      {
        id: 'entry-uuid-aaaa',
        accountId: 'account-uuid-cash',
        debit: 100,
        credit: 0,
      },
      {
        id: 'entry-uuid-bbbb',
        accountId: 'account-uuid-revenue',
        debit: 0,
        credit: 100,
      },
    ];
    (journal as any).getTotalDebits = async () => 100;
    (journal as any).getTotalCredits = async () => 100;
    (journal as any).isBalanced = async () => true;
    return journal;
  }

  it('uses the registered prompt key', () => {
    expect(smrtLedgersJournalSummarizePrompt.key).toBe(
      'smrtLedgers.journal.summarize',
    );
  });

  it('resolves the registered summarize prompt and returns trimmed AI output', async () => {
    const journal = makeJournal();

    const result = await journal.summarize();

    expect(result).toBe('Generated summary text');
    expect(aiMessageMock).toHaveBeenCalledTimes(1);

    // The prompt sent to the AI should contain the substituted number,
    // date, description, status, total, entry count, and balanced flag
    // from the registered template.
    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('JNL-0001');
    expect(text).toContain('2026-05-01');
    expect(text).toContain('Cash sale of widgets');
    expect(text).toContain('posted');
    expect(text).toContain('$100.00');
    expect(text).toContain('Entries: 2');
    expect(text).toContain('Balanced: Yes');
  });

  it('does NOT pass internal/PII-adjacent fields to the AI provider', async () => {
    const journal = makeJournal();

    await journal.summarize();

    const [text] = aiMessageMock.mock.calls[0];
    // Foreign-key references that link to identifying records.
    expect(text).not.toContain('journal-uuid-1234');
    expect(text).not.toContain('tenant-uuid-9999');
    expect(text).not.toContain('INV-PRIVATE-9999');
    // Per-entry account IDs and entry IDs must not leak via aggregate path.
    expect(text).not.toContain('entry-uuid-aaaa');
    expect(text).not.toContain('entry-uuid-bbbb');
    expect(text).not.toContain('account-uuid-cash');
    expect(text).not.toContain('account-uuid-revenue');
    // Extensible metadata may contain analytics IDs, secrets, or other
    // tenant-private configuration — must not leak into prompts.
    expect(text).not.toContain('UA-PRIVATE-12345');
    expect(text).not.toContain('do-not-leak');
  });

  it('renders Balanced: No when the journal does not balance', async () => {
    const journal = makeJournal();
    (journal as any).isBalanced = async () => false;
    (journal as any).getTotalDebits = async () => 100;

    await journal.summarize();

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('Balanced: No');
  });

  it('passes empty AI options for the default registered prompt (no ai config)', async () => {
    const journal = makeJournal();

    await journal.summarize();

    expect(aiMessageMock).toHaveBeenCalledTimes(1);
    // The default registered prompt has no model/temperature/maxTokens/params,
    // so the options object derived by promptMessageOptions should be empty.
    const [, options] = aiMessageMock.mock.calls[0];
    expect(options).toEqual({});
  });

  it('forwards model/temperature/maxTokens from a runtime ai override to ai.message', async () => {
    // Drive promptMessageOptions directly with a synthetic ResolvedPromptAI
    // shape — this exercises the same helper Journal.summarize calls and
    // documents the contract for tenant overrides that set ai-config fields.
    const { promptMessageOptions } = await import('../prompts.js');

    const options = promptMessageOptions({
      profile: null,
      model: 'gpt-test-1',
      temperature: 0.42,
      maxTokens: 256,
      params: { topP: 0.9 },
    });

    expect(options).toEqual({
      topP: 0.9,
      model: 'gpt-test-1',
      temperature: 0.42,
      maxTokens: 256,
    });
  });
});

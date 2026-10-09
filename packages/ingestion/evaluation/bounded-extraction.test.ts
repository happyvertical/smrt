import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { emptyExtraction } from '../src/extraction-providers.js';
import type {
  ExtractionAdapter,
  ExtractionRequest,
} from '../src/extraction-types.js';
import { extractionRequest } from '../src/test-support/extraction-fixtures.js';
import {
  budgetExtractionAdapter,
  type FrozenExtractionCall,
} from './bounded-extraction.js';
import { BudgetLedger } from './budget.mjs';

async function fixture() {
  const bytes = await sharp({
    create: { width: 1000, height: 1000, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  const request = extractionRequest(bytes, 'image/png');
  const configuration: FrozenExtractionCall = {
    callId: 'case:ocr:source',
    runHash: 'a'.repeat(64),
    profileDigest: 'b'.repeat(64),
    source: {
      sha256: request.evidence.contentHash,
      mediaType: 'image/png',
      byteLength: bytes.length,
    },
    configurationRevision: request.configurationRevision,
    limits: request.limits,
  };
  return { request, configuration };
}
test('authority precedes durable reservation; provider sees reserve and repeat/restart handshakes cannot invoke', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-extract-'));
  const path = join(root, 'ledger.sqlite');
  let ledger = new BudgetLedger(path);
  const { request, configuration } = await fixture();
  let allowed = false,
    calls = 0;
  const authorityBalances: number[] = [];
  request.beforeProviderCall = async () => {
    authorityBalances.push(ledger.snapshot().charged);
    if (!allowed) throw Error('Revoked');
  };
  const adapter: ExtractionAdapter = {
    extract: async (input) => {
      await input.beforeProviderCall!();
      expect(ledger.snapshot().charged).toBe(265572000);
      await input.beforeProviderCall!();
      calls++;
      await expect(input.beforeProviderCall!()).rejects.toThrow('Repeated');
      return emptyExtraction(input);
    },
  };
  try {
    await expect(
      budgetExtractionAdapter(adapter, ledger, configuration).extract(request),
    ).rejects.toThrow('Revoked');
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
    allowed = true;
    await budgetExtractionAdapter(adapter, ledger, configuration).extract(
      request,
    );
    expect(calls).toBe(1);
    expect(authorityBalances).toEqual([0, 0, 265572000]);
    expect(ledger.snapshot().unknownChargeCalls).toBe(1);
    ledger.close();
    ledger = new BudgetLedger(path);
    request.beforeProviderCall = async () => {};
    await expect(
      budgetExtractionAdapter(adapter, ledger, configuration).extract(request),
    ).rejects.toThrow('already reserved');
    expect(calls).toBe(1);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('changed bytes, dimensions, media or extraction configuration fail before provider/reservation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-extract-bound-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  const { request, configuration } = await fixture();
  request.beforeProviderCall = async () => {};
  let calls = 0;
  const adapter: ExtractionAdapter = {
    extract: async (input) => {
      calls++;
      return emptyExtraction(input);
    },
  };
  try {
    for (const altered of [
      { ...request, bytes: Buffer.from('changed') },
      {
        ...request,
        evidence: { ...request.evidence, mediaType: 'image/jpeg' },
      },
      { ...request, limits: { ...request.limits, maxTokens: 100000 } },
      { ...request, configurationRevision: 'changed' },
    ])
      await expect(
        budgetExtractionAdapter(adapter, ledger, configuration).extract(
          altered,
        ),
      ).rejects.toThrow('profile mismatch');
    const small = await sharp({
      create: { width: 999, height: 1000, channels: 3, background: 'white' },
    })
      .png()
      .toBuffer();
    const smallRequest = extractionRequest(small, 'image/png');
    smallRequest.beforeProviderCall = request.beforeProviderCall;
    const smallConfiguration = {
      ...configuration,
      source: {
        ...configuration.source,
        byteLength: small.length,
        sha256: createHash('sha256').update(small).digest('hex'),
      },
    };
    await expect(
      budgetExtractionAdapter(adapter, ledger, smallConfiguration).extract(
        smallRequest,
      ),
    ).rejects.toThrow('Image outside');
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test('failure after paid handshake retains full unknown charge; local PDF permits no second fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-extract-failure-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  const { request, configuration } = await fixture();
  request.beforeProviderCall = async () => {};
  try {
    const fail: ExtractionAdapter = {
      extract: async (input) => {
        await input.beforeProviderCall!();
        throw Error('Timeout after reserved capability check');
      },
    };
    await expect(
      budgetExtractionAdapter(fail, ledger, configuration).extract(request),
    ).rejects.toThrow('Timeout');
    expect(ledger.snapshot().charged).toBe(265572000);
    expect(ledger.snapshot().unknownChargeCalls).toBe(1);
    const pdf: ExtractionRequest = extractionRequest(
      Buffer.from('local-fault-pdf'),
      'application/pdf',
    );
    pdf.beforeProviderCall = async () => {};
    const local = {
      ...configuration,
      callId: 'local-pdf',
      source: {
        sha256: pdf.evidence.contentHash,
        mediaType: 'application/pdf',
        byteLength: pdf.bytes.length,
      },
    };
    await budgetExtractionAdapter(
      {
        extract: async (input) => {
          for (
            let boundary = 0;
            boundary < 2 + 2 * input.limits.maxPages;
            boundary++
          )
            await input.beforeProviderCall!();
          await expect(input.beforeProviderCall!()).rejects.toThrow('Repeated');
          return emptyExtraction(input);
        },
      },
      ledger,
      local,
    ).extract(pdf);
    expect(ledger.snapshot().charged).toBe(265572000);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('frozen PCM duration is verified before the one full-context speech reservation', async () => {
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
  request.beforeProviderCall = async () => {};
  const configuration: FrozenExtractionCall = {
    callId: 'case:speech',
    runHash: 'd'.repeat(64),
    profileDigest: 'e'.repeat(64),
    source: {
      sha256: request.evidence.contentHash,
      mediaType: 'audio/wav',
      byteLength: bytes.length,
      durationSeconds: 1,
    },
    configurationRevision: request.configurationRevision,
    limits: request.limits,
  };
  const root = mkdtempSync(join(tmpdir(), 'evaluation-speech-bound-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  let calls = 0;
  const adapter: ExtractionAdapter = {
    extract: async (input) => {
      await input.beforeProviderCall!();
      calls++;
      return emptyExtraction(input);
    },
  };
  try {
    await expect(
      budgetExtractionAdapter(adapter, ledger, {
        ...configuration,
        source: { ...configuration.source, durationSeconds: 2 },
      }).extract(request),
    ).rejects.toThrow('duration');
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(0);
    await budgetExtractionAdapter(adapter, ledger, configuration).extract(
      request,
    );
    expect(calls).toBe(1);
    expect(ledger.snapshot().charged).toBe(30000000);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('revocation between capability and OCR denies send; late authority cannot reserve after extraction ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-extract-live-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  const { request, configuration } = await fixture();
  let gates = 0,
    calls = 0;
  request.beforeProviderCall = async () => {
    if (++gates === 2) throw Error('Revoked after capability');
  };
  try {
    await expect(
      budgetExtractionAdapter(
        {
          extract: async (input) => {
            await input.beforeProviderCall!();
            await input.beforeProviderCall!();
            calls++;
            return emptyExtraction(input);
          },
        },
        ledger,
        configuration,
      ).extract(request),
    ).rejects.toThrow('Revoked');
    expect(gates).toBe(2);
    expect(calls).toBe(0);
    expect(ledger.snapshot().charged).toBe(265572000);
    expect(ledger.snapshot().unknownChargeCalls).toBe(1);
    let release!: () => void;
    const latch = new Promise<void>((resolve) => {
      release = resolve;
    });
    request.beforeProviderCall = async () => {
      await latch;
    };
    let pending!: Promise<void>;
    await budgetExtractionAdapter(
      {
        extract: async (input) => {
          pending = input.beforeProviderCall!();
          return emptyExtraction(input);
        },
      },
      ledger,
      { ...configuration, callId: 'late-authority' },
    ).extract(request);
    const denied = expect(pending).rejects.toThrow('already ended');
    release();
    await denied;
    expect(ledger.snapshot().charged).toBe(265572000);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

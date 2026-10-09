import { getPDFReader } from '@happyvertical/pdf';
import { expect, test } from 'vitest';
import { extractWithProviders } from '../src/extraction-providers.js';
import { extractionRequest } from '../src/test-support/extraction-fixtures.js';

test('actual corrupt PDF/image and explicit speech-failure boundary remain generic failures, never invented structural success', async () => {
  const client = await getPDFReader({ provider: 'unpdf', enableOCR: false });
  const pdf = await extractWithProviders(
    extractionRequest(
      Buffer.from('CORRUPT pdf synthetic unreadable-material-11\n'),
      'application/pdf',
    ),
    {
      pdf: {
        client,
        identity: { provider: 'unpdf', model: 'none', version: '0.65.9' },
      },
    },
  );
  const image = await extractWithProviders(
    extractionRequest(
      Buffer.from('CORRUPT png synthetic unreadable-material-17\n'),
      'image/png',
    ),
    {},
  );
  let speechCalls = 0;
  const speech = await extractWithProviders(
    extractionRequest(
      Buffer.from('CORRUPT wav synthetic unreadable-material-19\n'),
      'audio/wav',
    ),
    {
      speech: {
        identity: {
          provider: 'deterministic-fault',
          model: 'no-remote-inference',
          version: '1',
        },
        client: {
          type: 'openai-compatible',
          transcribe: async () => {
            speechCalls++;
            throw new Error('Injected provider rejects corrupt audio');
          },
        },
      },
    },
  );
  expect(speechCalls).toBe(1);
  for (const [output, category] of [
    [pdf, 'malformed_output'],
    [image, 'unavailable'],
    [speech, 'unavailable'],
  ] as const) {
    expect(output.status).toBe('failed');
    expect(output.segments).toEqual([]);
    expect(output.automaticActionEligible).toBe(false);
    expect(output.errors).toContainEqual({
      category,
      location: { kind: 'source' },
    });
    expect(output.evidence.contentHash).toMatch(/^[a-f0-9]{64}$/);
  }
});

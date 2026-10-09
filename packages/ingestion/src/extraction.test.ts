import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  createSDKExtractionAdapter,
  proposeDocumentSplits,
} from './extraction.js';
import {
  type ExtractionProviders,
  extractWithProviders,
} from './extraction-providers.js';
import {
  extractionRequest,
  fixtureIdentity,
  multipageTIFF,
  pdfFixture,
  recordedToneWAV,
} from './test-support/extraction-fixtures.js';

async function png() {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
}
function ocr(
  overrides: Partial<NonNullable<ExtractionProviders['ocr']>> = {},
): NonNullable<ExtractionProviders['ocr']> {
  return {
    identity: fixtureIdentity,
    capabilities: async () => ({
      canPerformOCR: true,
      supportedLanguages: ['eng'],
      supportedFormats: ['png'],
      hasConfidenceScores: true,
      hasBoundingBoxes: true,
    }),
    performOCR: async () => ({
      text: 'invoice',
      confidence: 90,
      detections: [
        {
          text: 'invoice',
          confidence: 90,
          boundingBox: { x: 0, y: 0, width: 2, height: 2 },
        },
      ],
    }),
    ...overrides,
  };
}
describe('deterministic injected SDK extraction contracts (not quality evaluation)', () => {
  it('requires every declared identity field and strips extra host credentials', async () => {
    for (const field of ['provider', 'model', 'version']) {
      for (const value of [undefined, null, '', '   ', 42]) {
        expect(() =>
          createSDKExtractionAdapter({
            nativeMemoryIsolation: 'host-enforced',
            ocr: { identity: { ...fixtureIdentity, [field]: value } as never },
          }),
        ).toThrow('Explicit provider identity required');
      }
    }
    const identity = { ...fixtureIdentity, apiKey: 'identity-secret-marker' };
    const result = await extractWithProviders(
      extractionRequest(await png(), 'image/png'),
      { ocr: ocr({ identity }) },
    );
    expect(result.status).toBe('complete');
    expect(JSON.stringify(result)).not.toContain('identity-secret-marker');
    expect(result.segments[0].provenance).toEqual(fixtureIdentity);
    expect(Object.keys(result.capabilities[0]).sort()).toEqual(
      [
        'provider',
        'model',
        'version',
        'confidence',
        'boxes',
        'location',
        'truncation',
        'usage',
      ].sort(),
    );
  });
  it('retains email body/attachment source identity and raw HTML as text evidence', async () => {
    const request = extractionRequest(
      Buffer.from('<b>message</b>'),
      'text/html',
    );
    const result = await extractWithProviders(request, {});
    expect(result.status).toBe('complete');
    expect(result.evidence).toEqual(request.evidence);
    expect(result.segments[0]).toMatchObject({
      text: '<b>message</b>',
      location: { kind: 'source' },
      confidence: null,
      boxes: null,
    });
    expect(result.automaticActionEligible).toBe(false);
  });
  it('preserves JSON email/capture context as literal source evidence', async () => {
    const text = '{ "subject": "Invoice", "text": "Pay <b>later</b>" }';
    const request = extractionRequest(Buffer.from(text), 'application/json');
    const result = await extractWithProviders(request, {});
    expect(result.status).toBe('complete');
    expect(result.evidence).toEqual(request.evidence);
    expect(result.segments[0]).toMatchObject({
      text,
      location: { kind: 'source' },
      confidence: null,
      boxes: null,
    });
    expect(result.automaticActionEligible).toBe(false);
  });
  it.each([
    Buffer.from('{invalid'),
    Buffer.from([0xff]),
  ])('rejects malformed JSON or UTF-8 without publishing source segments', async (bytes) => {
    const result = await extractWithProviders(
      extractionRequest(bytes, 'application/json'),
      {},
    );
    expect(result.status).toBe('failed');
    expect(result.segments).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
  it('fails integrity before calling any provider and rejects video', async () => {
    const request = extractionRequest();
    request.evidence.contentHash = 'wrong';
    expect((await extractWithProviders(request, {})).errors[0].category).toBe(
      'integrity',
    );
    expect(
      (
        await extractWithProviders(
          extractionRequest(Buffer.from('video'), 'video/mp4'),
          {},
        )
      ).status,
    ).toBe('unsupported');
  });
  it('retains embedded, scanned and mixed PDF page granularity and proposed splits', async () => {
    const image = await png();
    const result = await extractWithProviders(
      extractionRequest(Buffer.from('injected PDF'), 'application/pdf'),
      {
        pdf: {
          client: pdfFixture(
            ['first document', null, 'second document'],
            image,
          ),
          identity: fixtureIdentity,
        },
        ocr: ocr(),
      },
    );
    expect(result.status).toBe('complete');
    expect(result.segments.map((s) => s.text)).toEqual([
      'first document',
      'invoice',
      'second document',
    ]);
    expect(result.segments.map((s) => s.location)).toEqual(
      [1, 2, 3].map((page) => ({ kind: 'page', page })),
    );
    expect(proposeDocumentSplits(result, 1, [[1, 2], [3]])).toMatchObject({
      status: 'proposed',
      revision: 1,
      inputHash: result.evidence.contentHash,
    });
    expect(() => proposeDocumentSplits(result, 2, [[1], [1]])).toThrow();
    expect(() => proposeDocumentSplits(result, 2, [[4]])).toThrow();
  });
  it('discards Unlimited synthetic confidence and boxes even if a capability is misreported', async () => {
    const provider = ocr({
      identity: {
        provider: 'unlimited-ocr',
        model: 'unknown',
        version: 'unknown',
      },
      performOCR: async () => ({
        text: 'fax text',
        confidence: 100,
        detections: [
          {
            text: 'fax',
            confidence: 100,
            boundingBox: { x: 0, y: 0, width: 1, height: 1 },
          },
        ],
      }),
    });
    const result = await extractWithProviders(
      extractionRequest(await png(), 'image/png'),
      { ocr: provider },
    );
    expect(result.segments[0]).toMatchObject({ confidence: null, boxes: null });
    expect(result.capabilities[0]).toMatchObject({
      confidence: false,
      boxes: false,
      truncation: 'unknown',
      usage: 'unknown',
    });
    expect(result.automaticActionEligible).toBe(false);
  });
  it('retains explicitly absent confidence/locations and rejects malformed measured values', async () => {
    const request = extractionRequest(await png(), 'image/png');
    const result = await extractWithProviders(request, {
      ocr: ocr({
        capabilities: async () => ({
          canPerformOCR: true,
          supportedLanguages: [],
          supportedFormats: ['png'],
        }),
      }),
    });
    expect(result.segments[0]).toMatchObject({ confidence: null, boxes: null });
    expect(
      (
        await extractWithProviders(request, {
          ocr: ocr({
            performOCR: async () => ({ text: 'bad', confidence: 101 }),
          }),
        })
      ).errors[0].category,
    ).toBe('malformed_output');
    expect(
      (
        await extractWithProviders(request, {
          ocr: ocr({
            performOCR: async () => ({
              text: 'bad',
              confidence: 1,
              detections: [
                {
                  text: 'outside',
                  confidence: 1,
                  boundingBox: { x: 9, y: 0, width: 1, height: 1 },
                },
              ],
            }),
          }),
        })
      ).status,
    ).toBe('failed');
  });
  it('decodes real multipage TIFF bytes to PNG while preserving original pages and partial failures', async () => {
    let calls = 0;
    const provider = ocr({
      performOCR: async (images) => {
        expect(
          (await sharp(images[0].data as Uint8Array).metadata()).format,
        ).toBe('png');
        if (++calls === 2) throw new Error('private upstream detail');
        return { text: 'page one', confidence: 85 };
      },
    });
    const result = await extractWithProviders(
      extractionRequest(multipageTIFF(), 'image/tiff'),
      { ocr: provider },
    );
    expect(calls).toBe(2);
    expect(result.status).toBe('partial');
    expect(result.segments[0].location).toEqual({ kind: 'page', page: 1 });
    expect(result.errors).toContainEqual({
      category: 'unavailable',
      location: { kind: 'page', page: 2 },
    });
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('enforces bytes/pages/output limits and does not silently drop pages', async () => {
    const request = extractionRequest();
    request.limits.maxBytes = 1;
    expect((await extractWithProviders(request, {})).errors[0].category).toBe(
      'limit',
    );
    const tiff = extractionRequest(multipageTIFF(), 'image/tiff');
    tiff.limits.maxPages = 1;
    const partial = await extractWithProviders(tiff, { ocr: ocr() });
    expect(partial.status).toBe('partial');
    expect(partial.truncated).toBe(true);
    expect(partial.omitted).toContainEqual({
      kind: 'pages',
      startPage: 2,
      endPage: 2,
    });
    const small = extractionRequest();
    small.limits.maxOutputBytes = 1;
    expect((await extractWithProviders(small, {})).errors[0].category).toBe(
      'limit',
    );
  });
  it('normalizes recorded audio source or actual timestamp bounds without invented confidence', async () => {
    const transcribe = vi.fn(async () => ({
      text: 'recording',
      durationSeconds: 2,
      segments: [
        { text: 'recording', startSeconds: 0, endSeconds: 2, confidence: 1 },
      ],
    }));
    const request = extractionRequest(recordedToneWAV(), 'audio/wav');
    const result = await extractWithProviders(request, {
      speech: {
        identity: fixtureIdentity,
        client: { type: 'openai-compatible', transcribe },
      },
    });
    expect(result.segments[0]).toMatchObject({
      kind: 'transcript',
      confidence: null,
      location: { kind: 'time', startMs: 0, endMs: 2000 },
    });
    transcribe.mockResolvedValueOnce({
      text: 'bad',
      durationSeconds: 2,
      segments: [
        { text: 'bad', startSeconds: 3, endSeconds: 1, confidence: 1 },
      ],
    });
    expect(
      (
        await extractWithProviders(request, {
          speech: {
            identity: fixtureIdentity,
            client: { type: 'openai-compatible', transcribe },
          },
        })
      ).errors[0].category,
    ).toBe('malformed_output');
  });
  it('records camera observations and marks provider truncation as partial', async () => {
    const result = await extractWithProviders(
      extractionRequest(await png(), 'image/png'),
      {
        imageMode: 'vision',
        vision: {
          identity: fixtureIdentity,
          client: {
            getCapabilities: async () =>
              ({ vision: true, chat: true }) as Awaited<
                ReturnType<
                  NonNullable<
                    ExtractionProviders['vision']
                  >['client']['getCapabilities']
                >
              >,
            chat: async () => ({
              content: 'A door and an unreadable sign',
              model: 'fixture-scene',
              truncated: true,
              finishReason: 'length',
            }),
          },
        },
      },
    );
    expect(result.status).toBe('partial');
    expect(result.truncated).toBe(true);
    expect(result.segments[0].kind).toBe('observation');
  });
  it('records corrupt input and encryption without exposing exceptions', async () => {
    expect(
      (
        await extractWithProviders(
          extractionRequest(Buffer.from('broken'), 'image/tiff'),
          { ocr: ocr() },
        )
      ).status,
    ).toBe('failed');
    const client = pdfFixture(['text'], await png());
    client.extractMetadata = async () => ({ pageCount: 1, encrypted: true });
    expect(
      (
        await extractWithProviders(
          extractionRequest(Buffer.from('encrypted'), 'application/pdf'),
          { pdf: { client, identity: fixtureIdentity } },
        )
      ).status,
    ).toBe('unsupported');
  });
});

import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPDFReader } from '@happyvertical/pdf';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { createSDKExtractionAdapter as AdapterFactory } from './extraction.js';
import { extractWithProviders } from './extraction-providers.js';
import {
  embeddedPDF,
  extractionRequest,
  fixtureIdentity,
  multipageTIFF,
  recordedToneWAV,
} from './test-support/extraction-fixtures.js';

async function builtAdapter(): Promise<typeof AdapterFactory> {
  const module = await import(
    /* @vite-ignore */ pathToFileURL(resolve('dist/server.js')).href
  );
  return module.createSDKExtractionAdapter;
}
describe('real local SDK provider integration (no remote quality claims)', () => {
  it('verifies frozen corpus digests and real scanned/mixed PDF page rendering', async () => {
    const root = new URL('./test-support/extraction-corpus/', import.meta.url);
    const manifest = JSON.parse(
      await readFile(new URL('manifest.json', root), 'utf8'),
    );
    for (const entry of manifest.entries) {
      const bytes = await readFile(new URL(entry.file, root));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(
        entry.sha256,
      );
      expect(bytes.byteLength).toBe(entry.byteLength);
    }
    expect(
      (await sharp(await readFile(new URL('scene.jpg', root))).metadata())
        .format,
    ).toBe('jpeg');
    for (const file of ['scanned.pdf', 'mixed.pdf']) {
      const client = await getPDFReader({
        provider: 'unpdf',
        enableOCR: false,
      });
      const result = await extractWithProviders(
        extractionRequest(
          await readFile(new URL(file, root)),
          'application/pdf',
        ),
        {
          pdf: {
            client,
            identity: { provider: 'unpdf', model: 'none', version: 'unknown' },
          },
          ocr: {
            identity: fixtureIdentity,
            capabilities: async () => ({
              canPerformOCR: true,
              supportedLanguages: [],
              supportedFormats: ['png'],
            }),
            performOCR: async ([image]) => {
              expect(
                (await sharp(image.data as Uint8Array).metadata()).format,
              ).toBe('png');
              return { text: 'Injected raster observation', confidence: 100 };
            },
          },
        },
      );
      expect(result.errors).toEqual([]);
      expect(result.status).toBe('complete');
      expect(result.segments.at(-1)?.text).toBe('Injected raster observation');
    }
  });
  it('extracts JSON source context through the built disposable adapter', async () => {
    const create = await builtAdapter();
    const adapter = create({ nativeMemoryIsolation: 'host-enforced' });
    const text = '{"captureSource":"document","captureId":"capture-1"}';
    const request = extractionRequest(Buffer.from(text), 'application/json');
    const result = await adapter.extract(request);
    expect(result.status).toBe('complete');
    expect(result.evidence).toEqual(request.evidence);
    expect(result.segments[0].text).toBe(text);
    expect(result.automaticActionEligible).toBe(false);
  });
  it('extracts generated embedded PDF through actual installed PDF SDK', async () => {
    const client = await getPDFReader({ provider: 'unpdf', enableOCR: false });
    const result = await extractWithProviders(
      extractionRequest(embeddedPDF(), 'application/pdf'),
      {
        pdf: {
          client,
          identity: { provider: 'unpdf', model: 'none', version: 'unknown' },
        },
      },
    );
    expect(result.status).toBe('complete');
    expect(result.segments[0].text).toContain('Retained invoice 42');
    expect(result.segments[0].location).toEqual({ kind: 'page', page: 1 });
  });
  it('decodes two actual TIFF IFDs with sharp and keeps original-page mapping', async () => {
    const bytes = multipageTIFF();
    expect((await sharp(bytes).metadata()).pages).toBe(2);
    const pixels: number[] = [];
    const result = await extractWithProviders(
      extractionRequest(bytes, 'image/tiff'),
      {
        ocr: {
          identity: fixtureIdentity,
          capabilities: async () => ({
            canPerformOCR: true,
            supportedLanguages: [],
            supportedFormats: ['png'],
          }),
          performOCR: async ([image]) => {
            const decoded = await sharp(image.data as Uint8Array)
              .raw()
              .toBuffer();
            pixels.push(decoded[0]);
            return { text: `page ${pixels.length}`, confidence: 100 };
          },
        },
      },
    );
    expect(pixels).toEqual([255, 0]);
    expect(result.status).toBe('complete');
    // Decoder is real; OCR callback is explicitly injected, not provider accuracy.
    expect(result.segments.map((s) => s.location)).toEqual([
      { kind: 'page', page: 1 },
      { kind: 'page', page: 2 },
    ]);
  });
  it('runs actual installed PDF SDK in packaged disposable process', async () => {
    const create = await builtAdapter();
    const identity = {
      provider: 'unpdf',
      model: 'none',
      version: 'unknown',
      apiKey: 'child-identity-secret-marker',
    };
    const adapter = create({
      nativeMemoryIsolation: 'host-enforced',
      pdf: {
        provider: 'unpdf',
        identity,
      },
    });
    const result = await adapter.extract(
      extractionRequest(embeddedPDF(), 'application/pdf'),
    );
    expect(result.errors).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(
      'child-identity-secret-marker',
    );
    expect(Object.keys(result.segments[0].provenance).sort()).toEqual([
      'model',
      'provider',
      'version',
    ]);
    expect(result.segments[0].text).toContain('Retained invoice 42');
  });
  it('terminates a hung actual speech HTTP adapter and reports safe timeout', async () => {
    let received = false;
    const server = createServer((_request, _response) => {
      received = true;
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No server');
    try {
      const create = await builtAdapter();
      const adapter = create({
        nativeMemoryIsolation: 'host-enforced',
        speech: {
          identity: {
            provider: 'openai-compatible',
            model: 'test',
            version: 'unknown',
          },
          options: {
            type: 'openai-compatible',
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            model: 'test',
          },
        },
      });
      const request = extractionRequest(recordedToneWAV(), 'audio/wav');
      request.limits.timeoutMs = 5000;
      const result = await adapter.extract(request);
      expect(received).toBe(true);
      expect(result.status).toBe('failed');
      expect(result.errors).toContainEqual({
        category: 'timeout',
        location: { kind: 'source' },
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
  it('uses actual Unlimited-OCR HTTP SDK and discards its synthetic confidence', async () => {
    let requests = 0;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: 'Local deterministic OCR response' } },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    try {
      const create = await builtAdapter();
      const adapter = create({
        nativeMemoryIsolation: 'host-enforced',
        ocr: {
          identity: {
            provider: 'unlimited-ocr',
            model: 'Unlimited-OCR',
            version: 'unknown',
          },
          options: {
            baseUrl: `http://127.0.0.1:${address.port}`,
            transport: 'direct',
            stream: false,
          },
        },
      });
      const bytes = await readFile(
        new URL('./test-support/extraction-corpus/scene.jpg', import.meta.url),
      );
      const result = await adapter.extract(
        extractionRequest(bytes, 'image/jpeg'),
      );
      expect(result.errors).toEqual([]);
      expect(requests).toBe(1);
      expect(result.segments).toHaveLength(1);
      expect(
        result.segments.every(
          (segment) => segment.confidence === null && segment.boxes === null,
        ),
      ).toBe(true);
      expect(result.automaticActionEligible).toBe(false);
      expect(result.capabilities[0]).toMatchObject({
        truncation: 'unknown',
        usage: 'unknown',
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
  it('retains a completed page when the next actual OCR HTTP call times out', async () => {
    const server = createServer((request, _response) => {
      request.resume();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    try {
      const create = await builtAdapter();
      const adapter = create({
        nativeMemoryIsolation: 'host-enforced',
        pdf: {
          provider: 'unpdf',
          identity: { provider: 'unpdf', model: 'none', version: 'unknown' },
        },
        ocr: {
          identity: {
            provider: 'unlimited-ocr',
            model: 'Unlimited-OCR',
            version: 'unknown',
          },
          options: {
            baseUrl: `http://127.0.0.1:${address.port}`,
            transport: 'direct',
            stream: false,
          },
        },
      });
      const bytes = await readFile(
        new URL('./test-support/extraction-corpus/mixed.pdf', import.meta.url),
      );
      const request = extractionRequest(bytes, 'application/pdf');
      request.limits.timeoutMs = 5000;
      const pending = adapter.extract(request);
      const excess = await adapter.extract(request);
      expect(excess.errors[0].category).toBe('limit');
      const result = await pending;
      expect(result.status).toBe('partial');
      expect(result.segments[0].text).toContain('Embedded first page');
      expect(result.errors).toContainEqual({
        category: 'timeout',
        location: { kind: 'source' },
      });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
  it('cancels before provider startup and refuses video without invoking a provider', async () => {
    const create = await builtAdapter();
    const adapter = create({ nativeMemoryIsolation: 'host-enforced' });
    const request = extractionRequest();
    request.signal = AbortSignal.abort();
    expect((await adapter.extract(request)).errors[0].category).toBe(
      'cancelled',
    );
    expect(
      (
        await adapter.extract(
          extractionRequest(Buffer.from('video'), 'video/mp4'),
        )
      ).status,
    ).toBe('unsupported');
  });
});

import { describe, expect, it } from 'vitest';
import {
  DocumentConversionError,
  type DocumentConversionRequest,
  FakeDocumentConverter,
  GotenbergDocumentConverter,
} from '../index.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const request = (
  over: Partial<DocumentConversionRequest> = {},
): DocumentConversionRequest => ({
  bytes: Buffer.from('PK-office'),
  kind: 'docx',
  fileName: 'document.docx',
  limits: { maxInputBytes: 1024, maxOutputBytes: 1024, timeoutMs: 1000 },
  signal: new AbortController().signal,
  ...over,
});
const reply = (body: BodyInit | null, init: ResponseInit = {}) =>
  (async () =>
    new Response(body, { status: 200, ...init })) as unknown as typeof fetch;

describe('GotenbergDocumentConverter', () => {
  it('posts the file to the LibreOffice route and returns the PDF', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const converter = new GotenbergDocumentConverter({
      baseUrl: 'http://gotenberg:3000/',
      fetch: (async (url: string, init: RequestInit) => {
        seen.push({ url, init });
        return new Response(PDF, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const out = await converter.convertToPdf(request());
    expect(Buffer.from(out.pdf).equals(PDF)).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      'http://gotenberg:3000/forms/libreoffice/convert',
    );
    expect(seen[0]?.init.method).toBe('POST');
    expect(seen[0]?.init.redirect).toBe('error');
    const form = seen[0]?.init.body as FormData;
    const file = form.get('files') as File;
    expect(file.name).toBe('document.docx');
    expect(file.size).toBe(9);
  });

  it('keeps a base path and accepts https', async () => {
    let url = '';
    const converter = new GotenbergDocumentConverter({
      baseUrl: 'https://svc.internal/office',
      fetch: (async (u: string) => {
        url = u;
        return new Response(PDF);
      }) as unknown as typeof fetch,
    });
    await converter.convertToPdf(request());
    expect(url).toBe('https://svc.internal/office/forms/libreoffice/convert');
  });

  it.each([
    [500, 'unavailable'],
    [503, 'unavailable'],
    [400, 'rejected'],
    [422, 'rejected'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const converter = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      fetch: reply('nope', { status }),
    });
    await expect(converter.convertToPdf(request())).rejects.toMatchObject({
      code,
    });
  });

  it('rejects a response that is not a PDF', async () => {
    const converter = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      fetch: reply('<html>'),
    });
    await expect(converter.convertToPdf(request())).rejects.toMatchObject({
      code: 'invalid_output',
    });
  });

  it('refuses an oversize input without calling the service', async () => {
    let called = false;
    const converter = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      maxBytes: 4,
      fetch: (async () => {
        called = true;
        return new Response(PDF);
      }) as unknown as typeof fetch,
    });
    await expect(converter.convertToPdf(request())).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(called).toBe(false);
  });

  it('caps the response by header and by streamed bytes', async () => {
    const small = request({
      limits: { maxInputBytes: 1024, maxOutputBytes: 10, timeoutMs: 1000 },
    });
    const byHeader = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      fetch: reply(PDF, { headers: { 'content-length': '999999' } }),
    });
    await expect(byHeader.convertToPdf(small)).rejects.toMatchObject({
      code: 'too_large',
    });
    const byStream = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      fetch: reply(Buffer.concat([PDF, Buffer.alloc(100)])),
    });
    await expect(byStream.convertToPdf(small)).rejects.toMatchObject({
      code: 'too_large',
    });
  });

  it('maps a network failure to unavailable and a spent budget to timeout', async () => {
    const down = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    await expect(down.convertToPdf(request())).rejects.toMatchObject({
      code: 'unavailable',
    });
    const slow = new GotenbergDocumentConverter({
      baseUrl: 'http://g',
      timeoutMs: 10,
      fetch: ((_: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        })) as unknown as typeof fetch,
    });
    await expect(slow.convertToPdf(request())).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('refuses unusable configuration', () => {
    expect(
      () => new GotenbergDocumentConverter({ baseUrl: 'not a url' }),
    ).toThrow(/http/);
    expect(
      () => new GotenbergDocumentConverter({ baseUrl: 'file:///tmp' }),
    ).toThrow(/http/);
    expect(
      () => new GotenbergDocumentConverter({ baseUrl: 'http://u:p@host' }),
    ).toThrow(/credentials/);
    expect(
      () =>
        new GotenbergDocumentConverter({ baseUrl: 'http://g', timeoutMs: 0 }),
    ).toThrow();
  });
});

describe('FakeDocumentConverter', () => {
  it('records calls, fails on demand and honours the abort signal', async () => {
    const ok = new FakeDocumentConverter();
    const out = await ok.convertToPdf(request());
    expect(Buffer.from(out.pdf).toString()).toContain('%PDF-');
    expect(ok.calls).toEqual([
      { kind: 'docx', fileName: 'document.docx', byteLength: 9 },
    ]);
    await expect(
      new FakeDocumentConverter({ failWith: 'rejected' }).convertToPdf(
        request(),
      ),
    ).rejects.toBeInstanceOf(DocumentConversionError);
    const controller = new AbortController();
    const pending = new FakeDocumentConverter({ delayMs: 5000 }).convertToPdf(
      request({ signal: controller.signal }),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });
});

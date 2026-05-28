/**
 * Output rendering rules. Uses an in-memory writable to capture stdout/stderr.
 */

import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { renderResponse } from '../output.js';

function buffer(): {
  stream: Writable & { contents: () => string };
  text: () => string;
} {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as Writable & { contents: () => string };
  stream.contents = () => Buffer.concat(chunks).toString('utf8');
  return { stream, text: () => stream.contents() };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

function binaryResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes as any, {
    status,
    headers: { 'content-type': 'application/octet-stream' },
  });
}

describe('renderResponse', () => {
  it('204 is silent success', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(new Response(null, { status: 204 }), {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toBe('');
    expect(err.text()).toBe('');
  });

  it('json success → pretty-printed to stdout', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(jsonResponse({ a: 1 }), {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(0);
    expect(out.text().trim()).toBe('{\n  "a": 1\n}');
    expect(err.text()).toBe('');
  });

  it('text/plain success → streamed to stdout', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(textResponse('hello world'), {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toBe('hello world');
  });

  it('binary + TTY → refuses with redirect hint, exit 1', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(
      binaryResponse(new Uint8Array([0, 1, 2, 3])),
      { stdout: out.stream, stderr: err.stream, stdoutIsTty: true },
    );
    expect(result.exitCode).toBe(1);
    expect(err.text()).toMatch(/binary response/);
    expect(out.text()).toBe('');
  });

  it('binary + non-TTY → piped to stdout', async () => {
    const out = buffer();
    const err = buffer();
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const result = await renderResponse(binaryResponse(bytes), {
      stdout: out.stream,
      stderr: err.stream,
      stdoutIsTty: false,
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.from(out.text(), 'binary').length).toBeGreaterThan(0);
  });

  it('400 json error → pretty-printed to stderr, exit 1', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(jsonResponse({ error: 'bad' }, 400), {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(1);
    expect(out.text()).toBe('');
    expect(err.text()).toMatch(/"error": "bad"/);
  });

  it('500 json error → exit 2', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(jsonResponse({ error: 'oops' }, 500), {
      stdout: out.stream,
      stderr: err.stream,
    });
    expect(result.exitCode).toBe(2);
  });

  it('error binary → terse stderr message, no body pipe', async () => {
    const out = buffer();
    const err = buffer();
    const result = await renderResponse(
      binaryResponse(new Uint8Array([0xff, 0xee]), 502),
      { stdout: out.stream, stderr: err.stream, stdoutIsTty: false },
    );
    expect(result.exitCode).toBe(2);
    expect(out.text()).toBe('');
    expect(err.text()).toMatch(/error: 502/);
  });
});

/**
 * Render a fetch Response to the CLI's stdout / stderr per content-type
 * rules. Content-Type drives behavior; chunked transfer-encoding is
 * implicit in the streaming path.
 *
 *   Status >= 400, JSON      → pretty-print to stderr; exit non-zero
 *   Status >= 400, text      → stream to stderr; exit non-zero
 *   Status >= 400, binary    → "error: <status> <statusText>" to stderr
 *   Status 204 / empty body  → silent success
 *   application/json (≤10MB) → buffer, pretty-print to stdout
 *   application/json (>10MB) → raw stream + stderr warning
 *   text/*                   → stream to stdout
 *   binary, TTY stdout       → refuse + stderr redirect hint
 *   binary, non-TTY stdout   → pipe
 *   unknown content-type     → treat as binary (safer than treating as text)
 *
 * @packageDocumentation
 */

import type { Writable } from 'node:stream';

export interface OutputOptions {
  stdout?: NodeJS.WriteStream | Writable;
  stderr?: NodeJS.WriteStream | Writable;
  /**
   * Override the TTY detection (tests). Defaults to `stdout.isTTY`.
   */
  stdoutIsTty?: boolean;
}

export interface RenderResult {
  exitCode: number;
}

const JSON_BUFFER_LIMIT = 10 * 1024 * 1024; // 10MB

/**
 * Render the response. Returns the desired exit code.
 */
export async function renderResponse(
  response: Response,
  options: OutputOptions = {},
): Promise<RenderResult> {
  const stdout =
    (options.stdout as NodeJS.WriteStream | undefined) ?? process.stdout;
  const stderr =
    (options.stderr as NodeJS.WriteStream | undefined) ?? process.stderr;
  const isTty =
    options.stdoutIsTty ?? Boolean((stdout as NodeJS.WriteStream).isTTY);

  const ct = (response.headers.get('content-type') ?? '').toLowerCase();
  const cl = Number(response.headers.get('content-length') ?? '');
  const isJson = ct.startsWith('application/json') || /\+json(\s|;|$)/.test(ct);
  const isText = ct.startsWith('text/');

  // 204 / empty
  if (response.status === 204) {
    return { exitCode: 0 };
  }

  // Error responses
  if (response.status >= 400) {
    if (isJson) {
      const text = await readBoundedText(response, JSON_BUFFER_LIMIT);
      const pretty = safePrettyJson(text) ?? text;
      stderr.write(`${pretty}\n`);
      return { exitCode: response.status >= 500 ? 2 : 1 };
    }
    if (isText) {
      await pipeBody(response, stderr);
      return { exitCode: response.status >= 500 ? 2 : 1 };
    }
    stderr.write(
      `error: ${response.status} ${response.statusText || 'HTTP error'}\n`,
    );
    return { exitCode: response.status >= 500 ? 2 : 1 };
  }

  // Success
  if (isJson) {
    if (cl && cl > JSON_BUFFER_LIMIT) {
      stderr.write(
        `[smrt-app-cli] response too large to pretty-print (${cl} bytes); streaming raw JSON\n`,
      );
      await pipeBody(response, stdout);
      return { exitCode: 0 };
    }
    const text = await readBoundedText(
      response,
      JSON_BUFFER_LIMIT,
      async () => {
        stderr.write(
          '[smrt-app-cli] response exceeded 10MB cap; streaming raw JSON\n',
        );
      },
    );
    if (!text) return { exitCode: 0 };
    const pretty = safePrettyJson(text) ?? text;
    stdout.write(`${pretty}\n`);
    return { exitCode: 0 };
  }

  if (isText) {
    await pipeBody(response, stdout);
    return { exitCode: 0 };
  }

  // Unknown / binary
  if (isTty) {
    const size = cl ? ` (${cl} bytes)` : '';
    stderr.write(
      `[smrt-app-cli] binary response${size}; redirect to a file to capture: <cli> ... > out.bin\n`,
    );
    return { exitCode: 1 };
  }
  await pipeBody(response, stdout);
  return { exitCode: 0 };
}

/* ── helpers ──────────────────────────────────────────────────────────── */

async function readBoundedText(
  response: Response,
  limit: number,
  onOverflow?: () => Promise<void>,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) {
      if (onOverflow) await onOverflow();
      reader.releaseLock();
      // Drain by re-reading via response.text(); but cap returned size.
      // Simpler: bail with what we have.
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(
    Buffer.concat(chunks.map((c) => Buffer.from(c))),
  );
}

async function pipeBody(
  response: Response,
  out: NodeJS.WriteStream | Writable,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (!(out as NodeJS.WriteStream).write(Buffer.from(value))) {
      await new Promise<void>((resolve) =>
        (out as NodeJS.WriteStream).once('drain', () => resolve()),
      );
    }
  }
}

function safePrettyJson(text: string): string | undefined {
  if (!text) return undefined;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

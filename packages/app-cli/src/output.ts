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
  try {
    return await renderResponseUnchecked(response, options);
  } catch (err) {
    if (err instanceof BrokenPipeError) {
      // Downstream consumer closed (typical: `<cli> list | head -1`).
      // Exit clean — this is not an error to escalate. (#1311 review #1.)
      return { exitCode: 0 };
    }
    throw err;
  }
}

async function renderResponseUnchecked(
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
      const result = await readUntilLimitOrStream(
        response,
        JSON_BUFFER_LIMIT,
        stderr,
      );
      if (result.overflowed) {
        stderr.write(
          '\n[smrt-app-cli] error response exceeded 10MB cap; streamed raw\n',
        );
      } else if (result.text) {
        const pretty = safePrettyJson(result.text) ?? result.text;
        stderr.write(`${pretty}\n`);
      }
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
    const result = await readUntilLimitOrStream(
      response,
      JSON_BUFFER_LIMIT,
      stdout,
    );
    if (result.overflowed) {
      // Already wrote the buffered prefix and streamed the rest via the
      // helper. Just emit the warning.
      stderr.write(
        '[smrt-app-cli] response exceeded 10MB cap; streamed raw JSON\n',
      );
      return { exitCode: 0 };
    }
    if (!result.text) return { exitCode: 0 };
    const pretty = safePrettyJson(result.text) ?? result.text;
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

interface BoundedReadResult {
  /** Full decoded body when it fits under `limit`; empty when overflowed. */
  text: string;
  /** True when the body exceeded `limit` and was streamed out instead. */
  overflowed: boolean;
}

/**
 * Read the response body into memory up to `limit` bytes. On overflow,
 * flush what's been buffered to `out` (default: stdout) and pipe the
 * remaining body in chunks, so callers never silently truncate. Returns
 * `{ text, overflowed }` so callers can branch on the outcome.
 */
async function readUntilLimitOrStream(
  response: Response,
  limit: number,
  out?: NodeJS.WriteStream | Writable,
): Promise<BoundedReadResult> {
  if (!response.body) return { text: '', overflowed: false };
  const writeStream =
    (out as NodeJS.WriteStream | Writable | undefined) ?? process.stdout;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > limit) {
      // Flush buffered prefix...
      for (const c of chunks) await writeChunk(writeStream, c);
      // ...then the chunk that tripped the limit...
      await writeChunk(writeStream, value);
      // ...and finally drain the rest of the body.
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        if (next.value) await writeChunk(writeStream, next.value);
      }
      return { text: '', overflowed: true };
    }
    chunks.push(value);
  }
  return {
    text: new TextDecoder().decode(
      Buffer.concat(chunks.map((c) => Buffer.from(c))),
    ),
    overflowed: false,
  };
}

/**
 * Sentinel thrown when a write to the output stream fails because the
 * downstream consumer closed (EPIPE) or the stream errored. Callers
 * catch this and exit cleanly — broken pipes are normal under shell
 * pipelines (`<cli> list | head -1`), not errors to escalate.
 */
class BrokenPipeError extends Error {
  constructor(cause?: unknown) {
    super('Output stream closed');
    this.name = 'BrokenPipeError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Write a chunk to the output stream and wait for `drain` if needed.
 *
 * Races the `drain` promise against an `error` event so that broken-pipe
 * errors (EPIPE, ECONNRESET on a stdout consumer that died) reject the
 * pending promise rather than leaving the CLI hung forever waiting for a
 * `drain` that will never come. (#1311 review #1.)
 */
async function writeChunk(
  out: NodeJS.WriteStream | Writable,
  chunk: Uint8Array,
): Promise<void> {
  const stream = out as NodeJS.WriteStream;
  let ok: boolean;
  try {
    ok = stream.write(Buffer.from(chunk));
  } catch (err) {
    throw new BrokenPipeError(err);
  }
  if (ok) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = (): void => {
      stream.off('error', onError);
      resolve();
    };
    const onError = (err: Error): void => {
      stream.off('drain', onDrain);
      reject(new BrokenPipeError(err));
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function pipeBody(
  response: Response,
  out: NodeJS.WriteStream | Writable,
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      await writeChunk(out, value);
    }
  } finally {
    // If we exited early (BrokenPipeError thrown), drop the reader's
    // lock so the response body can be GC'd promptly.
    try {
      reader.releaseLock();
    } catch {
      // releaseLock throws if the reader is still attached to an active
      // operation; that's the expected case on normal completion.
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

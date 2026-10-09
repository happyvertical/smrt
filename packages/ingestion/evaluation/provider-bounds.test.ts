import { createServer } from 'node:http';
import { getTranscriber } from '@happyvertical/speech';
import { afterEach, expect, test } from 'vitest';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function wav() {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(2, 40);
  return bytes;
}
const model = 'gpt-4o-mini-transcribe-2025-12-15';
test('installed speech snapshot makes one JSON request: explicit retry false and JSON-only adaptation prevent hidden resend', async () => {
  let calls = 0;
  let status = 502;
  const bodies: string[] = [];
  const server = createServer(async (request, response) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(Buffer.concat(chunks).toString());
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      status === 200
        ? JSON.stringify({
            text: 'transport only',
            usage: JSON.parse('{"input_tokens":1,"output_tokens":1}'),
          })
        : JSON.stringify({
            error: { message: 'verbose_json response_format unsupported' },
          }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const client = await getTranscriber({
    type: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'local-non-secret-fixture',
    model,
    retry: false,
    responseFormat: 'json',
  });
  const invoke = () =>
    client.transcribe({
      audio: wav(),
      mimeType: 'audio/wav',
      responseFormat: 'verbose_json',
      timestampGranularities: ['segment'],
    });
  await expect(invoke()).rejects.toThrow();
  expect(calls).toBe(1);
  status = 400;
  await expect(invoke()).rejects.toThrow();
  expect(calls).toBe(2);
  status = 200;
  await expect(invoke()).resolves.toMatchObject({ text: 'transport only' });
  expect(calls).toBe(3);
  for (const body of bodies) {
    expect(body).toContain(model);
    expect(body).toContain('name="response_format"\r\n\r\njson');
    expect(body).not.toContain('timestamp_granularities');
  }
});

test('installed OCR factory pins one GPT-6 Luna request with 4096 output ceiling and no fallback retry', async () => {
  const { getOCR } = await import('@happyvertical/ocr');
  const sharp = (await import('sharp')).default;
  let calls = 0;
  let status = 200;
  const wire: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    wire.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      status === 200
        ? JSON.stringify({
            id: 'local-ocr',
            object: 'chat.completion',
            model: 'gpt-6-luna',
            choices: [
              JSON.parse(
                '{"index":0,"message":{"role":"assistant","content":"local transport fixture"},"finish_reason":"stop"}',
              ),
            ],
            usage: JSON.parse(
              '{"prompt_tokens":10,"completion_tokens":4,"total_tokens":14}',
            ),
          })
        : JSON.stringify({ error: { message: 'injected unavailable' } }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  const factory = getOCR({
    provider: 'litellm',
    fallbackProviders: [],
    providerConfig: {
      litellm: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: 'local-non-secret-fixture',
        model: 'gpt-6-luna',
        outputMode: 'simple',
        timeout: 5000,
      },
    },
  });
  const image = await sharp({
    create: { width: 1000, height: 1000, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  const input = [{ data: image, format: 'png', width: 1000, height: 1000 }];
  await expect(factory.performOCR(input)).resolves.toMatchObject({
    text: 'local transport fixture',
  });
  expect(calls).toBe(1);
  status = 500;
  await expect(factory.performOCR(input)).rejects.toThrow();
  expect(calls).toBe(2);
  for (const body of wire) {
    expect(body.model).toBe('gpt-6-luna');
    expect(body.max_completion_tokens).toBe(4096);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning_effort).toBeUndefined();
    const withoutImage = JSON.stringify(body).replace(
      /data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/g,
      'bounded-image',
    );
    expect(Buffer.byteLength(withoutImage)).toBeLessThanOrEqual(4096);
    expect((JSON.stringify(body).match(/data:image/g) ?? []).length).toBe(1);
    const encoded = /data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/.exec(
      JSON.stringify(body),
    );
    expect(encoded).not.toBeNull();
    const transmitted = await sharp(
      Buffer.from(encoded![1], 'base64'),
    ).metadata();
    expect(transmitted.width).toBe(1000);
    expect(transmitted.height).toBe(1000);
  }
});

test('budgeted proposal uses the owning SDK wire once within the complete envelope bound', async () => {
  const { getAI } = await import('@happyvertical/ai');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { BudgetLedger } = await import('./budget.mjs');
  const { createBudgetedProposalChat, proposalRequestBound, PROPOSAL_BOUND } =
    await import('./bounded-chat.mjs');
  let calls = 0;
  let received = '';
  let status = 200;
  const server = createServer(async (request, response) => {
    calls++;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = Buffer.concat(chunks).toString();
    response.writeHead(status, { 'content-type': 'application/json' });
    if (status !== 200) {
      response.end(JSON.stringify({ error: { message: 'local unavailable' } }));
      return;
    }
    response.end(
      JSON.stringify({
        id: 'local',
        model: PROPOSAL_BOUND.model,
        choices: [
          JSON.parse(
            '{"index":0,"message":{"role":"assistant","content":"{}"},"finish_reason":"stop"}',
          ),
        ],
      }),
    );
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('No port');
  const sdk = await getAI({
    type: 'openai',
    apiKey: 'local-non-secret-fixture',
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    defaultModel: PROPOSAL_BOUND.model,
    maxRetries: 0,
  });
  const root = mkdtempSync(join(tmpdir(), 'evaluation-sdk-wire-'));
  const ledger = new BudgetLedger(join(root, 'ledger.sqlite'));
  try {
    const client = createBudgetedProposalChat(
      ledger,
      { callId: 'wire', runHash: 'c'.repeat(64) },
      sdk,
    );
    const messages = [
      { role: 'system', content: 'JSON only' },
      { role: 'user', content: '{}' },
    ];
    const options = {
      model: PROPOSAL_BOUND.model,
      maxTokens: 1024,
      toolChoice: 'none',
      continueOnLength: false,
      responseFormat: { type: 'json_object' },
    };
    const bound = proposalRequestBound(messages, options);
    await client.chat(messages, options);
    expect(calls).toBe(1);
    expect(Buffer.byteLength(received)).toBeLessThanOrEqual(
      bound.serializedBytes,
    );
    expect(JSON.parse(received)).toMatchObject({
      model: PROPOSAL_BOUND.model,
      ...JSON.parse('{"reasoning_effort":"none"}'),
      messages,
      ...JSON.parse(
        '{"max_completion_tokens":1024,"response_format":{"type":"json_object"}}',
      ),
    });
    expect(JSON.parse(received).max_tokens).toBeUndefined();
    expect(JSON.parse(received).temperature).toBeUndefined();
    expect(ledger.snapshot().charged).toBe(1600000);
    status = 500;
    const failing = createBudgetedProposalChat(
      ledger,
      { callId: 'wire-failure', runHash: 'c'.repeat(64) },
      sdk,
    );
    await expect(failing.chat(messages, options)).rejects.toThrow();
    expect(calls).toBe(2);
    expect(ledger.snapshot().charged).toBe(3200000);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

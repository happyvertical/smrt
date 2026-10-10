import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const chat = vi.fn();
  return {
    environment: { dev: true },
    chat,
    getAI: vi.fn(async () => ({ chat })),
    resolveDevAIConfig: vi.fn(),
  };
});

vi.mock('$app/environment', () => ({
  get dev() {
    return mocks.environment.dev;
  },
}));
vi.mock('@happyvertical/ai', () => ({ getAI: mocks.getAI }));
vi.mock('../dev-ai.js', () => ({
  resolveDevAIConfig: mocks.resolveDevAIConfig,
}));

import { POST } from './+server.js';

const url = new URL('http://127.0.0.1:4187/api/dev-character-conversation');
const event = (request: Request, getClientAddress = () => '127.0.0.1') =>
  ({ request, getClientAddress }) as Parameters<typeof POST>[0];
const request = (body: unknown, options: RequestInit = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  });
const conversation = { messages: [{ role: 'user', content: 'Open setup.' }] };

describe('dev character conversation', () => {
  beforeEach(() => {
    mocks.environment.dev = true;
    mocks.chat.mockReset();
    mocks.getAI.mockClear();
    mocks.resolveDevAIConfig.mockReset();
    mocks.resolveDevAIConfig.mockReturnValue({
      provider: 'openai',
      apiKey: 'server-only-key',
      model: 'local-model',
    });
  });

  it.each([
    200, 201,
  ])('validates the shared draft boundary at %i characters', async (length) => {
    mocks.chat.mockResolvedValue({
      content: 'Draft',
      toolCalls: [
        {
          id: 'boundary',
          type: 'function',
          function: {
            name: 'stageDraft',
            arguments: JSON.stringify({ value: 'x'.repeat(length) }),
          },
        },
      ],
    });
    const outcome = POST(event(request(conversation)));
    if (length === 200) expect((await outcome).status).toBe(200);
    else await expect(outcome).rejects.toMatchObject({ status: 422 });
  });

  it('offers only fixed tools and returns a navigation proposal without applying it', async () => {
    mocks.chat.mockResolvedValue({
      content: 'I can open setup for you.',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'navigate', arguments: '{"section":"character"}' },
        },
      ],
    });

    const response = await POST(event(request(conversation)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      content: 'I can open setup for you.',
      model: 'local-model',
      proposal: {
        kind: 'navigate',
        section: 'character',
        preview: {
          title: 'Navigate in the dev workbench',
          description: 'Open the character section.',
        },
      },
    });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
    const [, options] = mocks.chat.mock.calls[0];
    expect(mocks.chat.mock.calls[0][0][0].content).toContain(
      '500 characters or fewer',
    );
    expect(mocks.chat.mock.calls[0][0][0].content).toContain(
      'Ignore silence, background noise, and nonmeaningful turns',
    );
    expect(options.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: 'navigate' }),
      }),
      expect.objectContaining({
        function: expect.objectContaining({ name: 'stageDraft' }),
      }),
    ]);
    expect(JSON.stringify(options.tools)).not.toContain('url');
    expect(JSON.stringify(options.tools)).not.toContain('javascript');
    // The route has no callback or side-effect channel: a proposal is returned
    // for the client to preview and confirm separately.
    expect(mocks.chat.mock.calls[0][0]).toHaveLength(2);
  });

  it('canonicalizes a draft proposal but does not stage it', async () => {
    mocks.chat.mockResolvedValue({
      content: '',
      toolCalls: [
        {
          id: 'call-2',
          type: 'function',
          function: {
            name: 'stageDraft',
            arguments: '{"value":"  Hello team  "}',
          },
        },
      ],
    });

    const response = await POST(event(request(conversation)));

    expect(await response.json()).toMatchObject({
      content: 'I have a proposal ready for your review.',
      proposal: {
        kind: 'stageDraft',
        value: 'Hello team',
        preview: {
          title: 'Stage a draft subject',
          description: 'Stage “Hello team” in the local draft form.',
        },
      },
    });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an unknown tool',
      { name: 'open_url', arguments: '{"url":"https://example.test"}' },
    ],
    ['non-JSON arguments', { name: 'navigate', arguments: '{' }],
    [
      'a malformed fixed-tool argument',
      { name: 'navigate', arguments: '{"section":"https://example.test"}' },
    ],
    [
      'unexpected properties',
      { name: 'stageDraft', arguments: '{"value":"Draft","apply":true}' },
    ],
  ])('rejects %s without any action', async (_label, functionCall) => {
    mocks.chat.mockResolvedValue({
      content: 'proposal',
      toolCalls: [
        { id: 'call-invalid', type: 'function', function: functionCall },
      ],
    });

    await expect(POST(event(request(conversation)))).rejects.toMatchObject({
      status: 422,
    });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });

  it('does not accept cross-origin or non-loopback callers', async () => {
    await expect(
      POST(
        event(
          request(conversation, {
            headers: { origin: 'https://attacker.test' },
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      POST(event(request(conversation), () => '203.0.113.10')),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('denies production before reading configuration or contacting a provider', async () => {
    mocks.environment.dev = false;
    await expect(POST(event(request(conversation)))).rejects.toMatchObject({
      status: 404,
    });
    expect(mocks.resolveDevAIConfig).not.toHaveBeenCalled();
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('bounds declared request bodies before contacting a provider', async () => {
    await expect(
      POST(
        event(
          request(conversation, {
            headers: { 'content-length': String(16 * 1024 + 1) },
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['a null request body', null],
    ['an array request body', []],
    ['a null message entry', { messages: [null] }],
  ])('returns a controlled 400 for %s', async (_label, body) => {
    await expect(POST(event(request(body)))).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.chat).not.toHaveBeenCalled();
  });

  it('hides provider failures', async () => {
    mocks.chat.mockRejectedValueOnce(new Error('credential leaked upstream'));
    await expect(POST(event(request(conversation)))).rejects.toMatchObject({
      status: 502,
      body: expect.not.stringContaining('credential'),
    });
  });

  it('forwards cancellation to the model and never returns a proposal', async () => {
    const controller = new AbortController();
    mocks.chat.mockImplementationOnce(
      async (_messages: unknown, options: { signal: AbortSignal }) => {
        controller.abort();
        expect(options.signal).toBe(controller.signal);
        throw new DOMException('Aborted', 'AbortError');
      },
    );
    await expect(
      POST(event(request(conversation, { signal: controller.signal }))),
    ).rejects.toMatchObject({ status: 499 });
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });
});

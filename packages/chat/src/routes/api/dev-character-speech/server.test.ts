import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const synthesize = vi.fn();
  return {
    environment: { dev: true },
    synthesize,
    getSpeechSynthesizer: vi.fn(async () => ({ synthesize })),
    resolveDevAIConfig: vi.fn(),
    resolvePersistence: vi.fn(() => null),
    loadPreferences: vi.fn(),
    closeHelper: vi.fn(),
    openHelper: vi.fn(),
  };
});

vi.mock('$app/environment', () => ({
  get dev() {
    return mocks.environment.dev;
  },
}));
vi.mock('@happyvertical/speech', () => ({
  getSpeechSynthesizer: mocks.getSpeechSynthesizer,
}));
vi.mock('../dev-ai.js', () => ({
  resolveDevAIConfig: mocks.resolveDevAIConfig,
}));
vi.mock('../../../dev-helper-server.js', () => ({
  openDevHelperService: mocks.openHelper,
}));
vi.mock('../dev-character-persistence/config.js', () => ({
  resolveDevCharacterPersistenceConfig: mocks.resolvePersistence,
  isLocalDevCharacterRequest: ({ dev, request, getClientAddress }: any) =>
    dev &&
    getClientAddress() === '127.0.0.1' &&
    (!request.headers.get('origin') ||
      request.headers.get('origin') === new URL(request.url).origin),
}));

import { POST } from './+server.js';

const url = new URL('http://127.0.0.1:4187/api/dev-character-speech');
const event = (request: Request, getClientAddress = () => '127.0.0.1') =>
  ({ request, url, getClientAddress }) as Parameters<typeof POST>[0];
const request = (body: unknown, options: RequestInit = {}) =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  });

describe('dev character speech', () => {
  beforeEach(() => {
    mocks.environment.dev = true;
    mocks.synthesize.mockReset();
    mocks.getSpeechSynthesizer.mockClear();
    mocks.resolveDevAIConfig.mockReset();
    mocks.resolvePersistence.mockReset();
    mocks.resolvePersistence.mockReturnValue(null);
    mocks.loadPreferences.mockReset();
    mocks.closeHelper.mockReset();
    mocks.openHelper.mockReset();
    mocks.resolveDevAIConfig.mockReturnValue({
      provider: 'openai',
      apiKey: 'test-key',
    });
    mocks.synthesize.mockResolvedValue({
      audio: new Uint8Array([1, 2, 3]),
      contentType: 'audio/wav',
    });
  });

  it('resolves the current saved Cedar voice server-side and ignores a forged body voice', async () => {
    mocks.resolvePersistence.mockReturnValue({ databaseUrl: '/tmp/helper.db' });
    mocks.loadPreferences.mockResolvedValue({
      preferences: { voiceId: 'cedar' },
    });
    mocks.openHelper.mockResolvedValue({
      context: { applicationId: 'server-owned' },
      service: { load: mocks.loadPreferences },
      close: mocks.closeHelper,
    });
    await POST(
      event(
        request({
          text: 'Hello',
          voice: 'attacker',
          baseUrl: 'https://evil.test',
          apiKey: 'stolen',
        }),
      ),
    );
    expect(mocks.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voice: 'cedar' }),
    );
    expect(mocks.getSpeechSynthesizer).toHaveBeenCalledWith(
      expect.objectContaining({ defaultVoice: 'cedar' }),
    );
    expect(mocks.closeHelper).toHaveBeenCalledOnce();
  });

  it('fails before provider use when the effective saved voice is unavailable', async () => {
    mocks.resolvePersistence.mockReturnValue({ databaseUrl: '/tmp/helper.db' });
    mocks.loadPreferences.mockResolvedValue({ preferences: null });
    mocks.openHelper.mockResolvedValue({
      context: {},
      service: { load: mocks.loadPreferences },
      close: mocks.closeHelper,
    });
    await expect(
      POST(event(request({ text: 'Hello', voice: 'cedar' }))),
    ).rejects.toMatchObject({ status: 503 });
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it('synthesizes an explicitly fixed local OpenAI voice and returns no-store audio', async () => {
    const response = await POST(event(request({ text: ' Hello Happy ' })));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    expect(mocks.getSpeechSynthesizer).toHaveBeenCalledWith({
      type: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      defaultModel: 'gpt-4o-mini-tts',
      defaultVoice: 'marin',
    });
    expect(mocks.synthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Hello Happy',
        model: 'gpt-4o-mini-tts',
        voice: 'marin',
        outputFormat: 'wav',
      }),
    );
  });

  it.each([
    [
      'non-loopback development host',
      new URL('http://192.168.1.3/api/dev-character-speech'),
    ],
    [
      'an HTTPS host',
      new URL('https://happyvertical.com/api/dev-character-speech'),
    ],
  ])('denies %s requests before configuration or provider use', async (_name, eventUrl) => {
    await expect(
      POST(event(request({ text: 'Hello' }), () => '203.0.113.1')),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it('denies even a loopback request outside development', async () => {
    mocks.environment.dev = false;
    await expect(POST(event(request({ text: 'Hello' })))).rejects.toMatchObject(
      { status: 404 },
    );
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it('denies a cross-origin browser request', async () => {
    await expect(
      POST(
        event(
          request(
            { text: 'Hello' },
            { headers: { origin: 'https://elsewhere.example' } },
          ),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it.each([
    ['missing configuration', undefined],
    ['a non-OpenAI configuration', { provider: 'qwen', apiKey: 'test-key' }],
    ['a configuration with no key', { provider: 'openai' }],
  ])('does not synthesize with %s', async (_name, config) => {
    mocks.resolveDevAIConfig.mockReturnValue(config);
    await expect(POST(event(request({ text: 'Hello' })))).rejects.toMatchObject(
      { status: 503 },
    );
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it.each([
    ['empty text', { text: '   ' }],
    ['non-string text', { text: 12 }],
    ['missing text', {}],
    ['too-long text', { text: 'x'.repeat(501) }],
    ['malformed JSON', '{'],
  ])('rejects %s without provider use', async (_name, body) => {
    await expect(POST(event(request(body)))).rejects.toMatchObject({
      status: 400,
    });
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it('rejects declared and actually streamed oversized bodies before provider use', async () => {
    await expect(
      POST(
        event(
          request({ text: 'Hello' }, { headers: { 'content-length': '2049' } }),
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
    const encoder = new TextEncoder();
    const streamed = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`{"text":"${'x'.repeat(2049)}"}`));
        controller.close();
      },
    });
    const chunked = new Request(url, {
      method: 'POST',
      body: streamed,
      duplex: 'half',
      headers: { 'content-type': 'application/json' },
    });
    await expect(POST(event(chunked))).rejects.toMatchObject({ status: 413 });
    expect(mocks.getSpeechSynthesizer).not.toHaveBeenCalled();
  });

  it('rejects an already-cancelled request before synthesis', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = request({ text: 'Hello' }, { signal: controller.signal });
    await expect(POST(event(aborted))).rejects.toMatchObject({ status: 499 });
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('does not expose provider failures', async () => {
    mocks.synthesize.mockRejectedValueOnce(
      new Error('provider credential details'),
    );
    await expect(POST(event(request({ text: 'Hello' })))).rejects.toMatchObject(
      { status: 502, body: expect.not.stringContaining('credential') },
    );
  });
});

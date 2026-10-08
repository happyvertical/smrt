import { beforeEach, describe, expect, it, vi } from 'vitest';

const chat = vi.fn();
vi.mock('$app/environment', () => ({ dev: true }));
vi.mock('@happyvertical/ai', () => ({ getAI: vi.fn(async () => ({ chat })) }));
vi.mock('@happyvertical/smrt-images', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@happyvertical/smrt-images')>()),
  createPhotoCutoutCoordinateGuide: vi.fn(
    async () => 'data:image/png;base64,R1VJREU=',
  ),
}));
vi.mock('../dev-ai.js', () => ({
  resolveDevAIConfig: vi.fn(() => ({ provider: 'openai', model: 'vision' })),
}));

import { POST } from './+server.js';

const rig = {
  rigKind: 'photo-cutout',
  version: 1,
  id: 'portrait',
  ariaLabel: 'Portrait',
  canvas: { width: 100, height: 120 },
  layers: [
    {
      id: 'head',
      assetId: 'source',
      role: 'head',
      clip: [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 110 },
        { x: 10, y: 110 },
      ],
    },
    {
      id: 'mouth',
      kind: 'solid',
      role: 'mouth-interior',
      color: { r: 1, g: 1, b: 1 },
      clip: [
        { x: 40, y: 70 },
        { x: 60, y: 70 },
        { x: 50, y: 80 },
      ],
    },
    {
      id: 'jaw',
      assetId: 'source',
      role: 'jaw',
      clip: [
        { x: 30, y: 65 },
        { x: 70, y: 65 },
        { x: 70, y: 100 },
        { x: 30, y: 100 },
      ],
    },
  ],
  jaw: { layerId: 'jaw', pivot: { x: 50, y: 65 } },
};
const body = { dataUrl: 'data:image/png;base64,AAAA', width: 100, height: 120 };
const event = (request: Request, getClientAddress = () => '127.0.0.1') =>
  ({ request, getClientAddress }) as Parameters<typeof POST>[0];
const outline = {
  points: [
    { x: 120, y: 100 },
    { x: 880, y: 100 },
    { x: 940, y: 700 },
    { x: 500, y: 940 },
    { x: 60, y: 700 },
  ],
};
const landmarks = {
  mouthLeft: { x: 350, y: 550 },
  mouthRight: { x: 650, y: 550 },
  chin: { x: 500, y: 850 },
};
const stageRequest = (
  stage: 'outline' | 'mouth-landmarks',
  signal?: AbortSignal,
) =>
  new Request('http://test/api', {
    method: 'POST',
    body: JSON.stringify({ ...body, stage }),
    signal,
  });

describe('dev character setup', () => {
  beforeEach(() => chat.mockReset());
  it('repairs one invalid rig then returns a validator-safe rig', async () => {
    const invalid = structuredClone(rig);
    invalid.jaw.pivot = { x: 5, y: 5 };
    chat
      .mockResolvedValueOnce({ content: JSON.stringify({ rig: invalid }) })
      .mockResolvedValueOnce({ content: JSON.stringify({ rig }) });
    const response = await POST(
      event(
        new Request('http://test/api', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    );
    expect(response.status).toBe(200);
    expect(chat).toHaveBeenCalledTimes(2);
    expect((await response.json()).rig.id).toBe('portrait');
    const repairMessages = chat.mock.calls[1][0];
    expect(repairMessages).toHaveLength(3);
    expect(repairMessages[0].content).toEqual(expect.any(Array));
    expect(repairMessages[1].role).toBe('assistant');
    expect(repairMessages[1].content).toContain('portrait');
    expect(repairMessages[2].content).toContain('jaw clip');
  });
  it('does not invent a preview when repair is still invalid', async () => {
    const invalid = structuredClone(rig);
    invalid.jaw.pivot = { x: 5, y: 5 };
    chat.mockResolvedValue({ content: JSON.stringify({ rig: invalid }) });
    await expect(
      POST(
        event(
          new Request('http://test/api', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('repairs an invalid outline with the original image, rejected JSON, and validator reason', async () => {
    chat
      .mockResolvedValueOnce({ content: JSON.stringify({ points: [] }) })
      .mockResolvedValueOnce({ content: JSON.stringify(outline) });
    const request = stageRequest('outline');
    const response = await POST(event(request));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outline });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0][1].signal).toBe(request.signal);
    expect(chat.mock.calls[0][1]).toMatchObject({
      maxTokens: 8192,
      reasoning: { effort: 'low', maxTokens: 1024 },
    });
    const repairMessages = chat.mock.calls[1][0];
    expect(repairMessages).toHaveLength(3);
    expect(repairMessages[0].content[1].image_url.url).toBe(body.dataUrl);
    expect(repairMessages[0].content[2].image_url.url).toBe(
      'data:image/png;base64,R1VJREU=',
    );
    expect(repairMessages[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify({ points: [] }),
    });
    expect(repairMessages[2].content).toContain('face outline needs');
  });
  it('repairs invalid mouth landmarks with the original cropped image and validator reason', async () => {
    const invalid = {
      mouthLeft: { x: 700, y: 550 },
      mouthRight: { x: 300, y: 550 },
      chin: { x: 500, y: 450 },
    };
    chat
      .mockResolvedValueOnce({ content: JSON.stringify(invalid) })
      .mockResolvedValueOnce({ content: JSON.stringify(landmarks) });
    const request = stageRequest('mouth-landmarks');
    const response = await POST(event(request));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ landmarks });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[0][1]).toMatchObject({
      maxTokens: 4096,
      reasoning: { effort: 'low', maxTokens: 1024 },
    });
    const repairMessages = chat.mock.calls[1][0];
    expect(repairMessages[0].content[1].image_url.url).toBe(body.dataUrl);
    expect(repairMessages[1]).toEqual({
      role: 'assistant',
      content: JSON.stringify(invalid),
    });
    expect(repairMessages[2].content).toContain('mouth and chin landmarks');
  });
  it('stops after one invalid outline repair and returns 422', async () => {
    chat.mockResolvedValue({ content: JSON.stringify({ points: [] }) });
    await expect(POST(event(stageRequest('outline')))).rejects.toMatchObject({
      status: 422,
    });
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('classifies a truncated outline before parsing and repairs it once', async () => {
    chat
      .mockResolvedValueOnce({
        content: '{"points":[',
        truncated: true,
      })
      .mockResolvedValueOnce({ content: JSON.stringify(outline) });

    const response = await POST(event(stageRequest('outline')));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outline });
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1][0][2].content).toContain(
      'model output was truncated at its token limit',
    );
  });
  it('does not make a third request when a repair is truncated', async () => {
    chat
      .mockResolvedValueOnce({ content: JSON.stringify({ points: [] }) })
      .mockResolvedValueOnce({
        content: '{"points":[',
        truncated: true,
      });

    await expect(POST(event(stageRequest('outline')))).rejects.toMatchObject({
      status: 422,
    });
    expect(chat).toHaveBeenCalledTimes(2);
  });
  it('forwards cancellation to the provider and does not attempt repair', async () => {
    const controller = new AbortController();
    controller.abort();
    chat.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));
    const request = stageRequest('mouth-landmarks', controller.signal);
    await expect(POST(event(request))).rejects.toMatchObject({ status: 499 });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].signal).toBe(request.signal);
  });
  it('does not start a repair after the caller cancels an invalid outline', async () => {
    const controller = new AbortController();
    chat.mockImplementationOnce(async () => {
      controller.abort();
      return { content: JSON.stringify({ points: [] }) };
    });
    await expect(
      POST(event(stageRequest('outline', controller.signal))),
    ).rejects.toMatchObject({ status: 499 });
    expect(chat).toHaveBeenCalledTimes(1);
  });
  it('rejects oversized requests before provider invocation', async () => {
    await expect(
      POST(
        event(
          new Request('http://test/api', {
            method: 'POST',
            headers: { 'content-length': String(12 * 1024 * 1024) },
            body: JSON.stringify(body),
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(chat).not.toHaveBeenCalled();
  });
  it('bounds a chunked body without a Content-Length header', async () => {
    const oversized = `{"dataUrl":"data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}"}`;
    await expect(
      POST(
        event(
          new Request('http://test/api', { method: 'POST', body: oversized }),
        ),
      ),
    ).rejects.toMatchObject({ status: 413 });
    expect(chat).not.toHaveBeenCalled();
  });
});

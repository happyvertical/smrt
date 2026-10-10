import { describe, expect, it, vi } from 'vitest';
import { createDevAssistantTransport } from './dev-assistant-transport.js';

describe('bounded development conversation', () => {
  it('keeps long multibyte conversations inside the wire byte and count limits', async () => {
    const bodies: string[] = [];
    const request = vi.fn(async (_url, init) => {
      bodies.push(init.body);
      return Response.json({ content: '答'.repeat(3000) });
    });
    const transport = createDevAssistantTransport(request as typeof fetch);
    for (let i = 0; i < 30; i++)
      await transport.sendMessage({
        threadId: 'test',
        clientRequestId: `${i}`,
        content: '文'.repeat(3000),
      });
    for (const body of bodies) {
      expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(
        16384,
      );
      expect(JSON.parse(body).messages.length).toBeLessThanOrEqual(24);
    }
    expect(JSON.parse(bodies.at(-1)!).messages.at(-1).role).toBe('user');
  });
  it('does not accumulate failed turns when retrying', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ content: 'ok' }));
    const transport = createDevAssistantTransport(request);
    const input = {
      threadId: 'test',
      clientRequestId: 'retry',
      content: 'hello',
    };
    await expect(transport.sendMessage(input)).rejects.toThrow();
    await transport.sendMessage(input);
    expect(JSON.parse(request.mock.calls[1][1].body).messages).toEqual([
      { role: 'user', content: 'hello' },
    ]);
    expect(await transport.loadMessages('test')).toHaveLength(2);
  });
});

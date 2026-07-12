import { describe, expect, it, vi } from 'vitest';
import type { Account } from '../models/Account.js';
import type { Message } from '../models/Message.js';
import { TelegramSender } from '../senders/TelegramSender.js';
import { ZulipSender } from '../senders/ZulipSender.js';

describe('ZulipSender', () => {
  it('uses bot basic auth and stream destination fields', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ result: 'success', id: 91 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const account = {
      isActive: true,
      hasCredentials: true,
      getConfiguration: () => ({
        site: 'https://chat.example.com',
        email: 'agent@example.com',
      }),
      getCredentials: async () => ({ apiKey: 'secret' }),
    } as unknown as Account;
    const message = {
      body: 'Hello Zulip',
      subject: 'Deploys',
      getEndpoint: async () => ({
        channel: 'zulip',
        isActive: true,
        getAddress: () => ({ type: 'stream', to: 'ops', topic: 'releases' }),
      }),
    } as unknown as Message;

    const result = await new ZulipSender(account, fetcher).send(message);
    expect(result).toMatchObject({ success: true, providerMessageId: '91' });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toBe('https://chat.example.com/api/v1/messages');
    expect(init?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from('agent@example.com:secret').toString('base64')}`,
    });
    expect(String(init?.body)).toContain('type=stream');
    expect(String(init?.body)).toContain('to=ops');
    expect(String(init?.body)).toContain('topic=releases');
  });
});

describe('TelegramSender', () => {
  it('does not call Telegram when the endpoint channel is wrong', async () => {
    const fetcher = vi.fn();
    const account = {
      isActive: true,
      hasCredentials: true,
      getCredentials: async () => ({ botToken: '123:token' }),
    } as unknown as Account;
    const message = {
      getEndpoint: async () => ({ channel: 'email', isActive: true }),
    } as unknown as Message;

    const result = await new TelegramSender(account, fetcher).send(message);
    expect(result.success).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

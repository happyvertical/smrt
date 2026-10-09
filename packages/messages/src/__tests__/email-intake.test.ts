import type { EmailClient, EmailMessage } from '@happyvertical/email';
import { describe, expect, it, vi } from 'vitest';
import { EmailAccount } from '../models/EmailAccount.js';

describe('configured email intake byte retrieval', () => {
  function fixture() {
    const account = new EmailAccount({
      id: 'account',
      isActive: true,
      providerType: 'gmail',
    });
    const message: EmailMessage = {
      messageId: 'rfc-id',
      threadId: 'thread',
      from: { address: 'sender@example.test' },
      to: [],
      subject: 'subject',
      text: 'body',
      date: new Date('2026-10-08'),
      headers: { authorization: 'secret-not-retained' },
      attachments: [
        {
          filename: 'a.pdf',
          contentType: 'application/pdf',
          size: 6,
          content: Buffer.from('%PDF-a'),
        },
        {
          contentType: 'image/tiff',
          size: 4,
          content: Buffer.from([73, 73, 42, 0]),
        },
      ],
    };
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      getMessage: vi.fn(async () => message),
    };
    vi.spyOn(account, 'createClient').mockResolvedValue(
      client as unknown as EmailClient,
    );
    return { account, message, client };
  }
  it('fetches and copies all attachment bytes, allowlisting message provenance', async () => {
    const { account, message, client } = fixture();
    const result = await account.readIntakeMessage('provider-uid', 4096);
    expect(client.getMessage).toHaveBeenCalledWith('provider-uid');
    expect(client.disconnect).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      messageId: 'rfc-id',
      threadId: 'thread',
      text: 'body',
    });
    expect(result.attachments).toHaveLength(2);
    expect(result.attachments[0].bytes).toEqual(Buffer.from('%PDF-a'));
    message.attachments![0].content!.fill(0);
    expect(result.attachments[0].bytes).toEqual(Buffer.from('%PDF-a'));
    expect(JSON.stringify(result)).not.toContain('secret-not-retained');
    expect(result.attachments[1].filename).toBe('');
  });
  it('enforces the exact persisted JSON metadata plus attachment payload boundary', async () => {
    const { account, message } = fixture();
    message.attachments![0].filename = 'résumé\n".pdf';
    const metadata = {
      accountId: 'account',
      messageId: 'rfc-id',
      threadId: 'thread',
      inReplyTo: '',
      subject: 'subject',
      text: 'body',
      html: '',
      date: '2026-10-08T00:00:00.000Z',
      attachments: [
        {
          partId: '0',
          filename: 'résumé\n".pdf',
          mediaType: 'application/pdf',
        },
        { partId: '1', filename: '', mediaType: 'image/tiff' },
      ],
    };
    const limit = Buffer.byteLength(JSON.stringify(metadata)) + 6 + 4;
    await expect(
      account.readIntakeMessage('uid', limit),
    ).resolves.toMatchObject({
      attachments: [{ filename: 'résumé\n".pdf' }, { filename: '' }],
    });
    await expect(
      account.readIntakeMessage('uid', limit - 1),
    ).rejects.toMatchObject({
      category: 'limit',
    });
  });
  it.each([
    'filename',
    'empty attachments',
  ])('rejects oversized %s metadata before copying payloads', async (kind) => {
    const { account, message, client } = fixture();
    const payload = Buffer.from([1]);
    message.attachments =
      kind === 'filename'
        ? [
            {
              filename: 'é"\n'.repeat(2000),
              contentType: 'application/pdf',
              content: payload,
            },
          ]
        : Array.from({ length: 100 }, () => ({
            filename: '',
            contentType: 'application/pdf',
            content: Buffer.alloc(0),
          }));
    const payloads = message.attachments.map(
      (attachment) => attachment.content,
    );
    const copy = vi.spyOn(Buffer, 'from');
    try {
      await expect(
        account.readIntakeMessage('uid', 1024),
      ).rejects.toMatchObject({ category: 'limit' });
      expect(
        copy.mock.calls.some(([value]) =>
          payloads.some((bytes) => value === bytes),
        ),
      ).toBe(false);
      expect(client.disconnect).toHaveBeenCalledOnce();
    } finally {
      copy.mockRestore();
    }
  });
  it('counts the empty attachments array at the no-attachment boundary', async () => {
    const { account, message } = fixture();
    message.attachments = [];
    const metadata = {
      accountId: 'account',
      messageId: 'rfc-id',
      threadId: 'thread',
      inReplyTo: '',
      subject: 'subject',
      text: 'body',
      html: '',
      date: '2026-10-08T00:00:00.000Z',
      attachments: [],
    };
    const limit = Buffer.byteLength(JSON.stringify(metadata));
    await expect(
      account.readIntakeMessage('uid', limit),
    ).resolves.toMatchObject({ attachments: [] });
    await expect(
      account.readIntakeMessage('uid', limit - 1),
    ).rejects.toMatchObject({ category: 'limit' });
  });
  it('fails metadata-only attachments, oversized input and upstream errors without leaking details', async () => {
    const { account, message, client } = fixture();
    delete message.attachments![0].content;
    message.attachments![0].path = '/must/not/read';
    await expect(account.readIntakeMessage('uid', 4096)).rejects.toThrow(
      'bytes unavailable',
    );
    expect(client.disconnect).toHaveBeenCalledOnce();
    message.attachments = [];
    await expect(account.readIntakeMessage('uid', 1)).rejects.toThrow('limit');
    client.getMessage.mockRejectedValueOnce(new Error('provider down'));
    await expect(account.readIntakeMessage('uid', 4096)).rejects.toThrow(
      'provider down',
    );
    expect(client.disconnect).toHaveBeenCalledTimes(3);
    account.isActive = false;
    await expect(account.readIntakeMessage('uid', 4096)).rejects.toThrow(
      'account unavailable',
    );
    expect(client.getMessage).toHaveBeenCalledTimes(3);
  });
  it('binds IMAP lookup to folder UIDVALIDITY and UID, independently of sender message ID', async () => {
    const { account, message } = fixture();
    account.providerType = 'imap';
    message.id = '42';
    const client = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      getMessage: vi.fn(async () => message),
      selectFolder: vi.fn(async () => ({ uidValidity: 123 })),
    };
    vi.spyOn(account, 'createClient').mockResolvedValue(
      client as unknown as EmailClient,
    );
    await expect(account.readIntakeMessage('sender-id', 4096)).rejects.toThrow(
      'immutable UID',
    );
    const identity = { folder: 'INBOX', uidValidity: 123, uid: '42' };
    expect(
      (await account.readIntakeMessage('sender-id', 4096, identity))
        .attachments,
    ).toHaveLength(2);
    expect(client.selectFolder).toHaveBeenCalledWith('INBOX');
    await expect(
      account.readIntakeMessage('sender-id', 4096, {
        ...identity,
        uidValidity: 124,
      }),
    ).rejects.toThrow('identity changed');
    await expect(
      account.readIntakeMessage('sender-id', 4096, { ...identity, uid: '43' }),
    ).rejects.toThrow('identity changed');
  });
});

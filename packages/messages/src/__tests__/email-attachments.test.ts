/**
 * Email attachments reach the transport (#3808).
 *
 * Mocking policy: only the external EmailClient is faked. Accounts, messages,
 * attachment rows and files are real (in-memory SQLite, temp files), so the
 * send lifecycle that records a failure on the message is the real one.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentCollection } from '../collections/AttachmentCollection';
import { EmailCollection } from '../collections/EmailCollection';
import { MessageCollection } from '../collections/MessageCollection';
import { Email } from '../models/Email';
import { EmailAccount } from '../models/EmailAccount';
import { MessagingEndpoint } from '../models/MessagingEndpoint';
import { PersonaMessageRoute } from '../models/PersonaMessageRoute';
import { TelegramAccount } from '../models/TelegramAccount';
import {
  messagingPrincipalFromPermissions,
  SEND_MESSAGES_PERMISSION,
} from '../permissions';
import { EmailSender } from '../senders/EmailSender';
import { PersonaMessagingService } from '../services/PersonaMessagingService';
import { prepareMessageParents } from './fk-fixtures.js';

// Includes bytes that are not valid UTF-8, so a text decode would corrupt it.
const PDF_BYTES = Buffer.concat([
  Buffer.from('%PDF-1.4 purchase order PO-1042 '),
  Buffer.from([0xff, 0xfe, 0x00, 0x80, 0xc3]),
]);
const TERMS_BYTES = Buffer.from('Net 30.');

function makeClient() {
  return {
    isConnected: () => true,
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    send: vi.fn(async () => ({
      messageId: 'provider-msg-1',
      accepted: ['orders@vendor.example'],
      rejected: [],
      response: '250 OK',
    })),
  };
}

function sentPayload(client: ReturnType<typeof makeClient>) {
  expect(client.send).toHaveBeenCalledOnce();
  return client.send.mock.calls[0][0] as {
    attachments?: Array<{
      filename?: string;
      contentType: string;
      size: number;
      content?: Buffer;
      contentId?: string;
      contentDisposition?: string;
    }>;
  };
}

// ============================================================================
// EmailSender with send-time attachments (no database)
// ============================================================================

describe('EmailSender send-time attachments', () => {
  const account = new EmailAccount({
    name: 'Shop',
    email: 'shop@example.com',
  });

  function draft() {
    return new Email({
      subject: 'Purchase order PO-1042',
      textBody: 'Please find our purchase order attached.',
      toAddresses: JSON.stringify([{ address: 'orders@vendor.example' }]),
    });
  }

  it('hands send-time bytes to the transport, Uint8Array as Buffer', async () => {
    const client = makeClient();
    const sender = new EmailSender(client as any, account);

    const result = await sender.send(draft(), {
      attachments: [
        {
          filename: 'PO-1042.pdf',
          contentType: 'application/pdf',
          content: PDF_BYTES,
        },
        {
          filename: 'logo.png',
          content: new Uint8Array([1, 2, 3]),
          contentId: 'logo',
          contentDisposition: 'inline',
        },
      ],
    });

    expect(result.success).toBe(true);
    const payload = sentPayload(client);
    expect(payload.attachments).toHaveLength(2);
    expect(payload.attachments?.[0]).toMatchObject({
      filename: 'PO-1042.pdf',
      contentType: 'application/pdf',
      size: PDF_BYTES.length,
      contentDisposition: 'attachment',
    });
    expect(payload.attachments?.[0].content?.equals(PDF_BYTES)).toBe(true);
    expect(payload.attachments?.[1]).toMatchObject({
      filename: 'logo.png',
      contentType: 'application/octet-stream',
      size: 3,
      contentId: 'logo',
      contentDisposition: 'inline',
    });
    expect(Buffer.isBuffer(payload.attachments?.[1].content)).toBe(true);
    expect([...(payload.attachments?.[1].content ?? [])]).toEqual([1, 2, 3]);
  });

  it('omits the attachments field when there is nothing to attach', async () => {
    const client = makeClient();
    const sender = new EmailSender(client as any, account);

    const result = await sender.send(draft());

    expect(result.success).toBe(true);
    expect(sentPayload(client).attachments).toBeUndefined();
  });

  it('fails before the transport when a send-time attachment has no filename', async () => {
    const client = makeClient();
    const sender = new EmailSender(client as any, account);

    const result = await sender.send(draft(), {
      attachments: [{ filename: '', content: PDF_BYTES }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('A send-time attachment needs a filename.');
    expect(client.send).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Email.send() with stored Attachment rows (real database and files)
// ============================================================================

describe('Email.send with stored attachments', () => {
  let db: DatabaseInterface;
  let dir: string;
  let client: ReturnType<typeof makeClient>;

  beforeEach(async () => {
    db = await getTestDatabase();
    await prepareMessageParents(db);
    dir = mkdtempSync(join(tmpdir(), 'smrt-email-attachments-'));
    client = makeClient();
    vi.spyOn(EmailAccount.prototype, 'createClient').mockResolvedValue(
      client as any,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
    if (db && typeof db.close === 'function') await db.close();
  });

  async function makeEmail() {
    const account = new EmailAccount({
      db,
      name: 'Shop',
      email: 'shop@example.com',
      providerType: 'smtp',
      isActive: true,
    });
    await account.initialize();
    await account.save();
    const emails = await EmailCollection.create({ db });
    const email = await emails.create({
      accountId: account.id ?? '',
      subject: 'Purchase order PO-1042',
      textBody: 'Please find our purchase order attached.',
      toAddresses: JSON.stringify([{ address: 'orders@vendor.example' }]),
      hasAttachments: true,
    });
    if (!email.id) throw new Error('Test setup failed');
    return email;
  }

  async function storeAttachment(
    messageId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const attachments = await AttachmentCollection.create({ db });
    return attachments.create({
      messageId,
      filename: 'PO-1042.pdf',
      contentType: 'application/pdf',
      size: PDF_BYTES.length,
      contentDisposition: 'attachment',
      ...overrides,
    });
  }

  async function reload(id: string) {
    const emails = await EmailCollection.create({ db });
    const row = await emails.get({ id });
    if (!row) throw new Error('Message row disappeared');
    return row;
  }

  it('reads the stored file and sends it as an attachment', async () => {
    const filePath = join(dir, 'PO-1042.pdf');
    writeFileSync(filePath, PDF_BYTES);
    const email = await makeEmail();
    await storeAttachment(email.id ?? '', { filePath });

    const result = await email.send();

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      providerMessageId: 'provider-msg-1',
    });
    const payload = sentPayload(client);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments?.[0]).toMatchObject({
      filename: 'PO-1042.pdf',
      contentType: 'application/pdf',
      size: PDF_BYTES.length,
      contentDisposition: 'attachment',
    });
    expect(payload.attachments?.[0].content?.equals(PDF_BYTES)).toBe(true);
    expect(payload.attachments?.[0].contentId).toBeUndefined();
    expect(await reload(email.id ?? '')).toMatchObject({
      sendStatus: 'sent',
      sendError: '',
    });
  });

  it('sends stored rows first, then the send-time attachments', async () => {
    const filePath = join(dir, 'PO-1042.pdf');
    writeFileSync(filePath, PDF_BYTES);
    const email = await makeEmail();
    await storeAttachment(email.id ?? '', { filePath });

    const result = await email.send({
      attachments: [
        {
          filename: 'terms.txt',
          contentType: 'text/plain',
          content: TERMS_BYTES,
        },
      ],
    });

    expect(result.success).toBe(true);
    const payload = sentPayload(client);
    expect(payload.attachments?.map((a) => a.filename)).toEqual([
      'PO-1042.pdf',
      'terms.txt',
    ]);
    expect(payload.attachments?.[1].content?.equals(TERMS_BYTES)).toBe(true);
  });

  it('fails the send and records the error when a stored file is missing', async () => {
    const filePath = join(dir, 'missing', 'PO-1042.pdf');
    const email = await makeEmail();
    await storeAttachment(email.id ?? '', { filePath });

    const result = await email.send();

    expect(result.success).toBe(false);
    expect(result.error).toContain(
      'Attachment "PO-1042.pdf" could not be read',
    );
    expect(result.error).toContain(filePath);
    expect(client.send).not.toHaveBeenCalled();
    // Recorded on the message exactly like a transport failure.
    expect(await reload(email.id ?? '')).toMatchObject({
      sendStatus: 'failed',
      sendError: result.error,
    });
  });

  it('fails the send for a stored row that has no file behind it', async () => {
    const email = await makeEmail();
    await storeAttachment(email.id ?? '', {
      filename: 'photo.jpg',
      contentType: 'image/jpeg',
      sourceUrl: 'https://media.example/photo.jpg',
    });

    const result = await email.send();

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      'Attachment "photo.jpg" has no stored file to send (a sourceUrl is not fetched at send time).',
    );
    expect(client.send).not.toHaveBeenCalled();
    expect((await reload(email.id ?? '')).sendStatus).toBe('failed');
  });
});

// ============================================================================
// PersonaMessagingService.send({ attachments })
// ============================================================================

describe('PersonaMessagingService attachments', () => {
  let db: DatabaseInterface;
  let client: ReturnType<typeof makeClient>;

  beforeEach(async () => {
    db = await getTestDatabase();
    await prepareMessageParents(db);
    client = makeClient();
    vi.spyOn(EmailAccount.prototype, 'createClient').mockResolvedValue(
      client as any,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (db && typeof db.close === 'function') await db.close();
  });

  async function route(
    tenantId: string,
    personaId: string,
    account: EmailAccount | TelegramAccount,
    channel: 'email' | 'telegram',
    address: Record<string, string>,
  ) {
    await account.initialize();
    await account.save();
    const endpoint = new MessagingEndpoint({
      db,
      tenantId,
      label: 'Vendor',
      channel,
      address: JSON.stringify(address),
    });
    await endpoint.initialize();
    await endpoint.save();
    if (!account.id || !endpoint.id) throw new Error('Test setup failed');
    const row = new PersonaMessageRoute({
      db,
      tenantId,
      personaId,
      accountId: account.id,
      endpointId: endpoint.id,
      purpose: 'default',
      priority: 10,
    });
    await row.initialize();
    await row.save();
    return new PersonaMessagingService({
      db,
      tenantId,
      principal: messagingPrincipalFromPermissions([SEND_MESSAGES_PERMISSION], {
        tenantId,
      }),
    });
  }

  it('attaches send-time bytes on an email route', async () => {
    const tenantId = crypto.randomUUID();
    const personaId = crypto.randomUUID();
    await withTenant({ tenantId }, async () => {
      const service = await route(
        tenantId,
        personaId,
        new EmailAccount({
          db,
          tenantId,
          name: 'Shop',
          email: 'shop@example.com',
          providerType: 'smtp',
        }),
        'email',
        { email: 'orders@vendor.example' },
      );

      const result = await service.send({
        personaId,
        subject: 'Purchase order PO-1042',
        body: 'Please find our purchase order attached.',
        attachments: [
          {
            filename: 'PO-1042.pdf',
            contentType: 'application/pdf',
            content: PDF_BYTES,
          },
        ],
      });

      expect(result.delivery).toMatchObject({
        success: true,
        providerMessageId: 'provider-msg-1',
      });
      const payload = sentPayload(client);
      expect(payload.attachments).toHaveLength(1);
      expect(payload.attachments?.[0]).toMatchObject({
        filename: 'PO-1042.pdf',
        contentType: 'application/pdf',
        size: PDF_BYTES.length,
      });
      const messages = await MessageCollection.create({ db });
      expect(await messages.get({ id: result.messageId })).toMatchObject({
        sendStatus: 'sent',
        hasAttachments: true,
      });
    });
  });

  it('rejects attachments on a non-email route before anything is persisted', async () => {
    const tenantId = crypto.randomUUID();
    const personaId = crypto.randomUUID();
    await withTenant({ tenantId }, async () => {
      const service = await route(
        tenantId,
        personaId,
        new TelegramAccount({
          db,
          tenantId,
          name: 'Bot',
          settings: JSON.stringify({ botToken: '12345:test_token' }),
        }),
        'telegram',
        { chatId: '987' },
      );

      await expect(
        service.send({
          personaId,
          body: 'Report attached.',
          attachments: [{ filename: 'report.pdf', content: PDF_BYTES }],
        }),
      ).rejects.toThrow('Attachments are only supported on email routes.');
      const messages = await MessageCollection.create({ db });
      expect(await messages.list({ where: { personaId } })).toHaveLength(0);
    });
  });
});

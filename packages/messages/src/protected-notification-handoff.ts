/** Package-private durable protection and one-use provider authority. Never exported from the package root. */

import { ObjectRegistry, type SmrtSaveOptions } from '@happyvertical/smrt-core';
import {
  canonicalNotificationMessageId as canonicalMessageId,
  createHandoffContext,
  notificationSha256,
} from './host.js';
import type { Message } from './models/Message.js';
import { assertNotificationRecipientIdentity } from './notification-recipient-identity.js';
import type { NotificationTransportRequest } from './services/NotificationOutboxService.js';
import type {
  SendEmailAttachment,
  SendEmailOptions,
  SendMessageOptions,
} from './types.js';

/** Definite local refusal: no provider handoff occurred. */
export class ProtectedNotificationHandoffError extends Error {}
const KEY = '__smrtProtectedOutbox';
type Row = Record<string, unknown>;
const origins = new WeakMap<
  Message,
  { id: string | null; hint: string | null; protected: boolean }
>();
const fields = [
  'tenantId',
  'accountId',
  'correlationId',
  'subject',
  'body',
  'fromAddress',
  'fromName',
  'toAddresses',
  'textBody',
  'htmlBody',
  'ccAddresses',
  'bccAddresses',
  'replyToAddress',
  'replyToName',
  'inReplyTo',
  'headers',
  'rawMessage',
] as const;
function column(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function hash(value: unknown): string {
  return notificationSha256(JSON.stringify(value));
}
function marker(value: unknown): Row | null {
  try {
    const bag = typeof value === 'string' ? JSON.parse(value || '{}') : value;
    const result = bag?.[KEY];
    return result && typeof result === 'object' ? result : null;
  } catch {
    return null;
  }
}
function hint(message: Message): string | null {
  const marked = marker(message.metadata)?.deliveryId;
  const candidate =
    typeof marked === 'string'
      ? marked
      : message.correlationId?.startsWith('notification-delivery:')
        ? message.correlationId.slice('notification-delivery:'.length)
        : null;
  return candidate &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      candidate,
    )
    ? candidate
    : null;
}
/** Remember constructor identity before public fields can be changed. */
export function rememberNotificationOrigin(message: Message): void {
  const previous = origins.get(message);
  origins.set(message, {
    id: previous?.id || message.id || null,
    hint: previous?.hint || hint(message),
    protected: Boolean(previous?.protected || marker(message.metadata)),
  });
}
/** Non-authorizing durable marker; forging it can only require stricter checks. */
export function protectedNotificationMetadata(
  deliveryId: string,
  policyId: string,
): string {
  return JSON.stringify({ [KEY]: { deliveryId, policyId } });
}
function snapshot(message: Message | Row, persisted = false): Row {
  const object = message as unknown as Row;
  return Object.fromEntries(
    fields.map((key) => [
      key,
      object[persisted ? column(key) : key] ?? (key === 'tenantId' ? null : ''),
    ]),
  );
}
function attachmentsDigest(
  attachments: readonly SendEmailAttachment[] | undefined,
): string {
  if (!attachments?.length)
    throw new ProtectedNotificationHandoffError(
      'Protected notification requires approved attachment bytes.',
    );
  return hash(
    attachments.map((file) => {
      if (!(file.content instanceof Uint8Array))
        throw new ProtectedNotificationHandoffError(
          'Protected notification requires actual attachment bytes.',
        );
      return {
        filename: file.filename,
        contentType: file.contentType || 'application/octet-stream',
        contentId: file.contentId ?? null,
        contentDisposition: file.contentDisposition ?? 'attachment',
        digest: notificationSha256(file.content),
      };
    }),
  );
}
async function association(
  message: Message,
): Promise<{ delivery: Row; stored: Row | null } | null> {
  const origin = origins.get(message);
  try {
    if (!message.db || typeof message.db.tableExists !== 'function') {
      if (origin?.protected || marker(message.metadata) || origin?.hint)
        throw new ProtectedNotificationHandoffError(
          'Protected notification requires durable storage.',
        );
      return null;
    }
  } catch (error) {
    if (
      error instanceof ProtectedNotificationHandoffError ||
      origin?.protected ||
      marker(message.metadata) ||
      origin?.hint
    )
      throw error;
    // The existing direct EmailSender contract also accepts ordinary unsaved
    // drafts without persistence. Such drafts carry no protected provenance.
    return null;
  }
  const ids = [
    ...new Set(
      [message.id, origin?.id].filter((id): id is string => Boolean(id)),
    ),
  ];
  const hints = [
    ...new Set(
      [hint(message), origin?.hint].filter((id): id is string => Boolean(id)),
    ),
  ];
  let persistedProtected = false;
  if (message.slug) {
    const qualified = ObjectRegistry.getClassByConstructor(
      message.constructor as typeof Message,
    )?.qualifiedName;
    const natural = (await message.db.get(message.tableName, {
      slug: message.slug,
      context: message.context ?? '',
      tenant_id: message.tenantId ?? null,
      ...(qualified ? { _meta_type: qualified } : {}),
    })) as Row | null;
    const binding = marker(natural?.metadata);
    if (binding) {
      persistedProtected = true;
      if (
        typeof binding.deliveryId === 'string' &&
        !hints.includes(binding.deliveryId)
      )
        hints.push(binding.deliveryId);
    }
  }
  for (const id of ids) {
    const stored = (await message.db.get(message.tableName, {
      id,
    })) as Row | null;
    const binding = marker(stored?.metadata);
    if (binding) {
      persistedProtected = true;
      if (
        typeof binding.deliveryId === 'string' &&
        !hints.includes(binding.deliveryId)
      )
        hints.push(binding.deliveryId);
    }
  }
  if (!(await message.db.tableExists('notification_deliveries'))) {
    if (persistedProtected || origin?.protected || marker(message.metadata))
      throw new ProtectedNotificationHandoffError(
        'Protected notification delivery storage is unavailable.',
      );
    return null;
  }
  const clauses: string[] = [];
  const values: string[] = [];
  if (ids.length) {
    clauses.push(`message_id IN (${ids.map(() => '?').join(',')})`);
    values.push(...ids);
  }
  if (hints.length) {
    clauses.push(`id IN (${hints.map(() => '?').join(',')})`);
    values.push(...hints);
  }
  if (!clauses.length) return null;
  const result = await message.db.query(
    `SELECT * FROM notification_deliveries WHERE required_dispatch_policy <> '' AND (${clauses.join(' OR ')})`,
    ...values,
  );
  const deliveries = result.rows as Row[];
  if (!deliveries.length) {
    if (persistedProtected || marker(message.metadata) || origin?.protected)
      throw new ProtectedNotificationHandoffError(
        'Protected notification binding is unavailable.',
      );
    return null;
  }
  if (deliveries.length !== 1)
    throw new ProtectedNotificationHandoffError(
      'Protected notification identity is ambiguous.',
    );
  const delivery = deliveries[0]!;
  const id = String(delivery.message_id || message.id || '');
  const stored = id
    ? ((await message.db.get('messages', { id })) as Row | null)
    : null;
  return { delivery, stored };
}
function canonical(message: Message, delivery: Row): void {
  if (message.id !== canonicalMessageId(String(delivery.id)))
    throw new ProtectedNotificationHandoffError(
      'Protected notification canonical identity cannot be cloned.',
    );
  const body = `${delivery.text_body}\n\n${delivery.href}\n`;
  const addresses = JSON.stringify([
    {
      address: delivery.recipient_address,
      ...(delivery.recipient_name ? { name: delivery.recipient_name } : {}),
    },
  ]);
  const object = message as unknown as Row;
  if (
    message.tenantId !== delivery.tenant_id ||
    message.accountId !== delivery.account_id ||
    message.subject !== delivery.subject ||
    message.body !== body ||
    object.textBody !== body ||
    message.toAddresses !== addresses ||
    message.correlationId !== `notification-delivery:${delivery.id}` ||
    [
      'fromAddress',
      'fromName',
      'htmlBody',
      'ccAddresses',
      'bccAddresses',
      'replyToAddress',
      'replyToName',
      'inReplyTo',
      'headers',
      'rawMessage',
    ].some((key) => Boolean(object[key]))
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification approved content or destination changed.',
    );
  const binding = marker(message.metadata);
  if (
    !binding ||
    binding.deliveryId !== delivery.id ||
    binding.policyId !== delivery.required_dispatch_policy
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification durable marker changed.',
    );
}
/** Prevent ordinary saves/identity changes/clones from stripping durable protection. */
export async function assertProtectedNotificationSave(
  message: Message,
  _options?: SmrtSaveOptions,
  lifecycleAuthorized = false,
): Promise<void> {
  const found = await association(message);
  if (!found) return;
  const { delivery, stored } = found;
  const origin = origins.get(message);
  if (
    (origin?.id && origin.id !== message.id) ||
    (delivery.message_id && delivery.message_id !== message.id)
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification message identity cannot change.',
    );
  canonical(message, delivery);
  if (stored) {
    if (!message.isPersisted)
      throw new ProtectedNotificationHandoffError(
        'Protected notification cannot adopt an existing message.',
      );
    if (hash(snapshot(message)) !== hash(snapshot(stored, true)))
      throw new ProtectedNotificationHandoffError(
        'Protected notification content is immutable.',
      );
    const instant = (value: unknown) =>
      value == null ? null : new Date(value as Date | string).getTime();
    const unknown = (value: unknown) => {
      try {
        return JSON.parse(String(value || '{}')).sendOutcomeUnknown === true;
      } catch {
        return false;
      }
    };
    const lifecycleChanged =
      stored.send_status !== message.sendStatus ||
      Number(stored.retry_count) !== message.retryCount ||
      Number(stored.max_retries) !== message.maxRetries ||
      String(stored.send_error ?? '') !== message.sendError ||
      instant(stored.sent_at) !== instant(message.sentAt) ||
      instant(stored.scheduled_send_at) !== instant(message.scheduledSendAt) ||
      unknown(stored.metadata) !== unknown(message.metadata);
    if (lifecycleChanged && !lifecycleAuthorized)
      throw new ProtectedNotificationHandoffError(
        'Protected notification lifecycle requires its outbox handoff.',
      );
  } else message.requireInsertOnSave();
}
interface Scope {
  active: boolean;
  started: boolean;
  genericHandedOff: boolean;
  emailHandedOff: boolean;
  message: Message;
  messageId: string;
  tenantId: string;
  deliveryId: string;
  lease: string;
  attempts: number;
  stateVersion: number;
  body: string;
  files: string;
  account: string;
  deliveryFingerprint: string;
  envelope: string;
  now: () => Date;
}
const authority = createHandoffContext<Scope>();
function deliveryDigest(delivery: Row): string {
  assertNotificationRecipientIdentity({
    recipientKind: delivery.recipient_kind ?? 'user',
    recipientUserId: delivery.recipient_user_id ?? null,
    recipientProfileId: delivery.recipient_profile_id ?? null,
    channel: delivery.channel,
    kind: delivery.kind,
    requiredDispatchPolicy: delivery.required_dispatch_policy ?? '',
  });
  return hash(
    Object.fromEntries(
      [
        'tenant_id',
        'message_id',
        'required_dispatch_policy',
        'dispatch_policy_binding',
        'kind',
        'subject',
        'text_body',
        'href',
        'recipient_kind',
        'recipient_user_id',
        'recipient_profile_id',
        'recipient_address',
        'recipient_name',
        'account_id',
      ].map((key) => [key, delivery[key]]),
    ),
  );
}
async function accountDigest(message: Message): Promise<string> {
  const account = await message.getAccount();
  if (!account || !account.isActive || account.tenantId !== message.tenantId)
    throw new ProtectedNotificationHandoffError(
      'Protected notification sender is unavailable.',
    );
  const view = account as unknown as Row;
  return hash({
    id: account.id,
    tenantId: account.tenantId,
    name: view.name,
    email: view.email,
    providerType: view.providerType,
  });
}
async function envelopeDigest(message: Message): Promise<string> {
  const account = await message.getAccount();
  const sender = account as unknown as Row;
  const email = message as unknown as Row;
  const addresses = (key: string) =>
    JSON.parse(String(email[key] || '[]')).map((row: Row) => ({
      name: row.name,
      address: row.address,
    }));
  const cc = addresses('ccAddresses');
  const bcc = addresses('bccAddresses');
  return hash({
    from: {
      name: message.fromName || sender.name,
      address: message.fromAddress || sender.email,
    },
    to: addresses('toAddresses'),
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject: message.subject,
    text: email.textBody || message.body,
    html: email.htmlBody || undefined,
    inReplyTo: email.inReplyTo || undefined,
  });
}
function actualEnvelopeDigest(envelope: Row): string {
  return hash(
    Object.fromEntries(
      ['from', 'to', 'cc', 'bcc', 'subject', 'text', 'html', 'inReplyTo'].map(
        (key) => [key, envelope[key]],
      ),
    ),
  );
}
async function validate(
  message: Message,
  options?: SendMessageOptions,
): Promise<Scope | null> {
  const found = await association(message);
  if (!found) return null;
  const scope = authority.getStore();
  if (
    !scope?.active ||
    scope.message !== message ||
    message.id !== scope.messageId ||
    message.tenantId !== scope.tenantId
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification send requires its current approved outbox handoff.',
    );
  canonical(message, found.delivery);
  const row = found.delivery;
  if (
    row.id !== scope.deliveryId ||
    row.status !== 'sending' ||
    row.lease_token !== scope.lease ||
    Number(row.attempts) !== scope.attempts ||
    Number(row.state_version) !== scope.stateVersion ||
    !row.handed_off_at ||
    new Date(row.lease_expires_at as string | Date).getTime() <=
      scope.now().getTime() ||
    deliveryDigest(row) !== scope.deliveryFingerprint ||
    !found.stored ||
    hash(snapshot(found.stored, true)) !== scope.body ||
    hash(snapshot(message)) !== scope.body ||
    attachmentsDigest(
      (options as SendEmailOptions | undefined)?.attachments,
    ) !== scope.files ||
    (await accountDigest(message)) !== scope.account ||
    !scope.active
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification handoff lease, attempt, destination or bytes changed.',
    );
  const current = (await message.db.get('notification_deliveries', {
    id: scope.deliveryId,
    tenant_id: scope.tenantId,
  })) as Row | null;
  if (
    !scope.active ||
    !current ||
    current.status !== 'sending' ||
    current.lease_token !== scope.lease ||
    Number(current.attempts) !== scope.attempts ||
    Number(current.state_version) !== scope.stateVersion ||
    new Date(current.lease_expires_at as string | Date).getTime() <=
      scope.now().getTime() ||
    deliveryDigest(current) !== scope.deliveryFingerprint
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification current handoff lease was lost.',
    );
  return scope;
}
/** Non-consuming retry admission; send itself claims the one-use token. */
export async function assertProtectedNotificationRetry(
  message: Message,
  options?: SendMessageOptions,
): Promise<void> {
  await validate(message, options);
}
/** Claim exactly one canonical send invocation before any provider/account action. */
export async function beginProtectedNotificationSend(
  message: Message,
  options?: SendMessageOptions,
): Promise<void> {
  const scope = await validate(message, options);
  if (!scope) return;
  if (scope.started)
    throw new ProtectedNotificationHandoffError(
      'Protected notification handoff was already used.',
    );
  scope.started = true;
}
/** Consume once immediately before the sender invocation. */
export async function assertProtectedSenderHandoff(
  message: Message,
  options?: SendMessageOptions,
): Promise<void> {
  const scope = await validate(message, options);
  if (!scope) return;
  if (!scope.started || scope.genericHandedOff)
    throw new ProtectedNotificationHandoffError(
      'Protected notification sender authority was already used.',
    );
  scope.genericHandedOff = true;
}
/** Deny unauthorized direct EmailSender calls before it reads stored attachment files. */
export async function assertProtectedEmailAdmission(
  message: Message,
  options?: SendEmailOptions,
): Promise<void> {
  const scope = await validate(message, options);
  if (!scope) return;
  if (!scope.started || !scope.genericHandedOff || scope.emailHandedOff)
    throw new ProtectedNotificationHandoffError(
      'Protected notification sender requires the unused canonical handoff.',
    );
}
/** Recheck after attachment I/O at the actual default EmailClient handoff; copied stored attachments cannot sneak in. */
export async function assertProtectedEmailHandoff(
  message: Message,
  attachments: readonly SendEmailAttachment[],
  options?: SendEmailOptions,
  envelope?: Row,
): Promise<void> {
  const scope = await validate(message, options);
  if (!scope) return;
  if (
    !scope.started ||
    !scope.genericHandedOff ||
    scope.emailHandedOff ||
    attachmentsDigest(attachments) !== scope.files ||
    !envelope ||
    actualEnvelopeDigest(envelope) !== scope.envelope ||
    !scope.active
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification provider authority was already used or its bytes changed.',
    );
  scope.emailHandedOff = true;
}
/** Only the outbox calls this after its trusted policy verified/copied bytes and recorded the current lease handoff. */
export async function withProtectedNotificationHandoff<T>(
  request: NotificationTransportRequest,
  now: () => Date,
  callback: () => Promise<T>,
): Promise<T> {
  const found = await association(request.message);
  if (!found) {
    if (
      request.delivery.requiredDispatchPolicy ||
      request.delivery.kind.startsWith('protected:')
    )
      throw new ProtectedNotificationHandoffError(
        'Protected notification durable association is missing.',
      );
    return callback();
  }
  if (
    found.delivery.required_dispatch_policy !==
    request.delivery.requiredDispatchPolicy
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification policy identity changed.',
    );
  if (
    !found ||
    found.delivery.id !== request.delivery.id ||
    found.delivery.message_id !== request.message.id
  )
    throw new ProtectedNotificationHandoffError(
      'Protected notification durable association is missing.',
    );
  canonical(request.message, found.delivery);
  const row = found.delivery;
  const scope: Scope = {
    active: true,
    started: false,
    genericHandedOff: false,
    emailHandedOff: false,
    message: request.message,
    messageId: request.message.id!,
    tenantId: request.delivery.tenantId,
    deliveryId: request.delivery.id!,
    lease: request.delivery.leaseToken!,
    attempts: request.delivery.attempts,
    stateVersion: request.delivery.stateVersion,
    body: hash(snapshot(request.message)),
    files: attachmentsDigest(request.attachments),
    account: await accountDigest(request.message),
    deliveryFingerprint: deliveryDigest(row),
    envelope: await envelopeDigest(request.message),
    now,
  };
  try {
    return await authority.run(scope, async () => {
      // Custom trusted transports are also a handoff seam; check the current
      // durable lease before yielding approved bytes to their callback.
      await validate(request.message, {
        attachments: request.attachments,
      } as SendEmailOptions);
      return callback();
    });
  } finally {
    scope.active = false;
  }
}

/** Retain the durable protected message association through ordinary model/collection deletion. */
export async function assertProtectedNotificationDelete(
  message: Message,
): Promise<void> {
  if (await association(message))
    throw new ProtectedNotificationHandoffError(
      'Protected notification message provenance cannot be deleted.',
    );
}

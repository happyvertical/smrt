import type { Account } from './models/Account.js';
import { TelegramSender } from './senders/TelegramSender.js';
import { ZulipSender } from './senders/ZulipSender.js';
import type { MessageSenderInterface, MessagingChannel } from './types.js';

export type MessagingProviderFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'select'
  | 'url'
  | 'email'
  | 'password';

export interface MessagingProviderField {
  id: string;
  label: string;
  type: MessagingProviderFieldType;
  required?: boolean;
  description?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
}

/** Public setup contract. Credential values are never represented here. */
export interface MessagingProviderDefinition {
  id: string;
  label: string;
  channel: MessagingChannel;
  available: boolean;
  configurationFields: MessagingProviderField[];
  credentialFields: MessagingProviderField[];
  endpointFields: MessagingProviderField[];
  createSender?: (account: Account) => Promise<MessageSenderInterface>;
}

const REGISTRY_KEY = Symbol.for('smrt.messaging.providers');

function registry(): Map<string, MessagingProviderDefinition> {
  const root = globalThis as typeof globalThis & {
    [REGISTRY_KEY]?: Map<string, MessagingProviderDefinition>;
  };
  root[REGISTRY_KEY] ??= new Map();
  return root[REGISTRY_KEY];
}

export function registerMessagingProvider(
  provider: MessagingProviderDefinition,
): () => void {
  registry().set(provider.id, provider);
  return () => registry().delete(provider.id);
}

export function getMessagingProvider(
  id: string,
): MessagingProviderDefinition | undefined {
  ensureBuiltinMessagingProvidersRegistered();
  return registry().get(id);
}

export function listMessagingProviders(
  options: { includeUnavailable?: boolean } = {},
) {
  ensureBuiltinMessagingProvidersRegistered();
  return [...registry().values()].filter(
    (provider) => options.includeUnavailable || provider.available,
  );
}

let builtinsRegistered = false;

export function ensureBuiltinMessagingProvidersRegistered(): void {
  if (builtinsRegistered) return;
  builtinsRegistered = true;

  const emailEndpoint: MessagingProviderField[] = [
    { id: 'email', label: 'Email address', type: 'email', required: true },
  ];
  const serverConfiguration: MessagingProviderField[] = [
    { id: 'email', label: 'From address', type: 'email', required: true },
    { id: 'host', label: 'Mail server', type: 'string', required: true },
    { id: 'port', label: 'Port', type: 'number', required: true },
    {
      id: 'secure',
      label: 'Use TLS',
      type: 'select',
      options: [
        { value: 'true', label: 'Yes' },
        { value: 'false', label: 'No' },
      ],
    },
  ];
  const passwordCredentials: MessagingProviderField[] = [
    { id: 'username', label: 'Username', type: 'string', required: true },
    { id: 'password', label: 'Password', type: 'password', required: true },
  ];

  for (const id of ['smtp', 'imap', 'pop3'] as const) {
    registerMessagingProvider({
      id,
      label: id.toUpperCase(),
      channel: 'email',
      // IMAP/POP3 remain registered for existing receive/sync accounts but are
      // not valid outbound transports.
      available: id === 'smtp',
      configurationFields: serverConfiguration,
      credentialFields: passwordCredentials,
      endpointFields: emailEndpoint,
    });
  }

  registerMessagingProvider({
    id: 'gmail',
    label: 'Gmail',
    channel: 'email',
    available: true,
    configurationFields: [
      { id: 'email', label: 'From address', type: 'email', required: true },
    ],
    credentialFields: [
      {
        id: 'clientId',
        label: 'OAuth client ID',
        type: 'string',
        required: true,
      },
      {
        id: 'clientSecret',
        label: 'OAuth client secret',
        type: 'password',
        required: true,
      },
      {
        id: 'refreshToken',
        label: 'OAuth refresh token',
        type: 'password',
        required: true,
      },
      { id: 'accessToken', label: 'OAuth access token', type: 'password' },
    ],
    endpointFields: emailEndpoint,
  });

  registerMessagingProvider({
    id: 'zulip',
    label: 'Zulip',
    channel: 'zulip',
    available: true,
    configurationFields: [
      { id: 'site', label: 'Zulip site URL', type: 'url', required: true },
      { id: 'email', label: 'Bot email', type: 'email', required: true },
    ],
    credentialFields: [
      { id: 'apiKey', label: 'Bot API key', type: 'password', required: true },
    ],
    endpointFields: [
      {
        id: 'type',
        label: 'Destination type',
        type: 'select',
        required: true,
        options: [
          { value: 'stream', label: 'Stream' },
          { value: 'private', label: 'Private message' },
        ],
      },
      {
        id: 'to',
        label: 'Stream or recipient',
        type: 'string',
        required: true,
      },
      { id: 'topic', label: 'Topic', type: 'string' },
    ],
    createSender: async (account) => new ZulipSender(account),
  });

  registerMessagingProvider({
    id: 'telegram',
    label: 'Telegram',
    channel: 'telegram',
    available: true,
    configurationFields: [],
    credentialFields: [
      { id: 'botToken', label: 'Bot token', type: 'password', required: true },
    ],
    endpointFields: [
      { id: 'chatId', label: 'Chat ID', type: 'string', required: true },
      { id: 'threadId', label: 'Topic/thread ID', type: 'number' },
    ],
    createSender: async (account) => new TelegramSender(account),
  });

  registerMessagingProvider({
    id: 'sms',
    label: 'SMS (provider required)',
    channel: 'sms',
    available: false,
    configurationFields: [],
    credentialFields: [],
    endpointFields: [
      {
        id: 'phoneNumber',
        label: 'Phone number',
        type: 'string',
        required: true,
      },
    ],
  });
}

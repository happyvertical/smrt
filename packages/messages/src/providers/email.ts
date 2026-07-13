/**
 * Explicit email provider entry point (#1979).
 *
 * Importing this module upgrades the builtin metadata-only email provider
 * definitions (smtp, imap, pop3, gmail) with a functional
 * `createEmailClient` backed by `@happyvertical/email`. Until a server
 * imports it, provider-neutral consumers carry zero email-SDK weight
 * (googleapis, nodemailer, imapflow, mailparser) and
 * `EmailAccount.createClient()` fails with an actionable error.
 *
 * The SDK itself is still loaded on first client construction, so importing
 * this entry keeps server startup cheap while making the dependency an
 * explicit part of the consumer's bundle contract.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-messages/providers/email';
 * ```
 */
import type { GetEmailClientOptions } from '@happyvertical/email';
import {
  ensureBuiltinMessagingProvidersRegistered,
  getMessagingProvider,
  registerMessagingProvider,
} from '../providers.js';

const EMAIL_PROVIDER_IDS = ['smtp', 'imap', 'pop3', 'gmail'] as const;

let registered = false;

/** Idempotently registers the email client factory on the email providers. */
export function ensureEmailMessagingProvider(): void {
  if (registered) return;
  registered = true;

  ensureBuiltinMessagingProvidersRegistered();
  for (const id of EMAIL_PROVIDER_IDS) {
    const definition = getMessagingProvider(id);
    if (!definition) continue;
    registerMessagingProvider({
      ...definition,
      createEmailClient: async (options: GetEmailClientOptions) => {
        const { getEmailClient } = await import('@happyvertical/email');
        return getEmailClient(options);
      },
    });
  }
}

ensureEmailMessagingProvider();

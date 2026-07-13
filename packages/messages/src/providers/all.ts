/**
 * Convenience entry point enabling every built-in messaging provider (#1979).
 *
 * Importing this module registers the email, Slack, and Twitter transports —
 * the explicit opt-in that makes their SDKs part of the consumer's bundle
 * contract. Telegram and Zulip are fetch-based and always functional from the
 * package root without any provider entry.
 *
 * @example
 * ```ts
 * // hooks.server.ts / server bootstrap
 * import '@happyvertical/smrt-messages/providers/all';
 * ```
 */
export { ensureEmailMessagingProvider } from './email.js';
export { ensureSlackMessagingProvider } from './slack.js';
export { ensureTwitterMessagingProvider } from './twitter.js';

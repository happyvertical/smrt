/**
 * The language model behind `smrt kitchen`'s chat endpoint (#3750): the
 * user's configured `@happyvertical/ai` provider, resolved the way the rest of
 * s-m-r-t resolves it (the `ai` block of `smrt.config.ts`, then `SMRT_AI_*`,
 * then the provider's own key variable such as `OPENAI_API_KEY`).
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  loadConfig,
  type ResolveAIProviderOptions,
  toAIClientOptions,
  tryResolveConfiguredAIProvider,
} from '@happyvertical/smrt-config';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** What the chat endpoint needs from a model. */
export interface KitchenAI {
  /** For the terminal: provider and model, never a key. */
  label: string;
  chat(messages: ChatMessage[]): Promise<string>;
}

export interface ResolveAIOptions {
  /** Where to look for `smrt.config.*` (default: the target dir, else the cwd). */
  dir?: string;
  env?: ResolveAIProviderOptions['env'];
  /** Build the client; tests pass a stub, the default is `getAI`. */
  createClient?: (options: ReturnType<typeof toAIClientOptions>) => Promise<{
    chat(
      messages: ChatMessage[],
      options?: Record<string, unknown>,
    ): Promise<{ content: string }>;
  }>;
}

async function defaultCreateClient(
  options: ReturnType<typeof toAIClientOptions>,
): Promise<ReturnType<NonNullable<ResolveAIOptions['createClient']>>> {
  const { getAI } = await import('@happyvertical/ai');
  return getAI(
    options as unknown as Parameters<typeof getAI>[0],
  ) as unknown as ReturnType<NonNullable<ResolveAIOptions['createClient']>>;
}

/**
 * The configured model, or null when no provider is configured (the kitchen
 * then runs the planner's in-browser model instead).
 */
export async function resolveKitchenAI(
  options: ResolveAIOptions = {},
): Promise<KitchenAI | null> {
  const searchFrom =
    options.dir && existsSync(resolve(options.dir))
      ? resolve(options.dir)
      : process.cwd();
  try {
    await loadConfig({ searchFrom });
  } catch {
    // An unreadable smrt.config is not fatal here: env variables still count.
  }
  const resolved = tryResolveConfiguredAIProvider({ env: options.env });
  if (!resolved?.provider) return null;
  const client = await (options.createClient ?? defaultCreateClient)(
    toAIClientOptions(resolved),
  );
  return {
    label: `${resolved.provider}${resolved.model ? ` (${resolved.model})` : ''}`,
    async chat(messages) {
      const response = await client.chat(messages, { temperature: 0 });
      return response.content;
    },
  };
}

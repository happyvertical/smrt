/** Explicit inference setup for `smrt kitchen` (#3750). */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  loadConfig,
  type ResolveAIProviderOptions,
  toAIClientOptions,
  tryResolveConfiguredAIProvider,
} from '@happyvertical/smrt-config';

export type KitchenInferenceMode = 'manual' | 'configured' | 'chatgpt';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** A stable, safe error returned by the chat endpoint. */
export class KitchenAIError extends Error {
  constructor(
    readonly code:
      | 'usage_limit'
      | 'workspace_restricted'
      | 'session_revoked'
      | 'temporarily_unavailable',
    message: string,
    readonly status: number,
    readonly recovery: string,
  ) {
    super(message);
    this.name = 'KitchenAIError';
  }
}

export type KitchenInferenceErrorCode =
  | 'KITCHEN_INFERENCE_REQUIRED'
  | 'KITCHEN_INFERENCE_OPTION'
  | 'KITCHEN_INFERENCE_CANCELLED'
  | 'KITCHEN_AI_NOT_CONFIGURED'
  | 'KITCHEN_CHATGPT_ACCOUNT_REQUIRED'
  | 'KITCHEN_CHATGPT_ACCOUNT_UNKNOWN'
  | 'KITCHEN_CHATGPT_MODEL_REQUIRED'
  | 'KITCHEN_CHATGPT_MODEL_UNKNOWN'
  | 'KITCHEN_CHATGPT_MODELS_UNAVAILABLE'
  | 'KITCHEN_CHATGPT_CONSENT_DECLINED'
  | 'KITCHEN_CHATGPT_SDK_UNAVAILABLE';

/** Typed setup failure intended for the terminal, with no credential values. */
export class KitchenInferenceError extends Error {
  constructor(
    readonly code: KitchenInferenceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KitchenInferenceError';
  }
}

/** What the chat endpoint needs from a model. */
export interface KitchenAI {
  /** For the terminal: provider/account/model, never a key or token. */
  label: string;
  chat(messages: ChatMessage[]): Promise<string>;
}

export interface KitchenInferenceSelection {
  mode?: string;
  provider?: string;
  model?: string;
  /** An issued ID for a saved account registration, never an OAuth token. */
  account?: string;
}

export interface KitchenChoice {
  value: string;
  label: string;
  description?: string;
}

export interface KitchenPrompter {
  select(message: string, choices: readonly KitchenChoice[]): Promise<string>;
}

interface ChatGPTAccount {
  clientId: string;
  email?: string;
}

interface ChatGPTModel {
  id: string;
  name?: string;
}

export interface ChatGPTKitchenRuntime {
  sessions(): Promise<ChatGPTAccount[]>;
  authorize(clientId?: string): Promise<ChatGPTAccount>;
  createClient(
    clientId: string,
    model?: string,
  ): Promise<{
    getModels(): Promise<ChatGPTModel[]>;
    chat(messages: ChatMessage[]): Promise<{ content: string }>;
  }>;
  mapError(error: unknown): KitchenAIError | undefined;
}

export interface ResolveAIOptions {
  /** Where to look for `smrt.config.*` (default: target dir, else cwd). */
  dir?: string;
  env?: ResolveAIProviderOptions['env'];
  selection?: KitchenInferenceSelection;
  interactive?: boolean;
  prompt?: KitchenPrompter;
  /** Build a configured provider; tests pass a stub, the default is `getAI`. */
  createClient?: (options: ReturnType<typeof toAIClientOptions>) => Promise<{
    chat(messages: ChatMessage[]): Promise<{ content: string }>;
  }>;
  /** SDK boundary injected by tests; the released SDK supplies the default. */
  createChatGPTRuntime?: () => Promise<ChatGPTKitchenRuntime>;
}

function openSystemBrowser(url: string): Promise<void> {
  const [command, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

async function defaultCreateClient(
  options: ReturnType<typeof toAIClientOptions>,
): Promise<ReturnType<NonNullable<ResolveAIOptions['createClient']>>> {
  const { getAI } = await import('@happyvertical/ai');
  return getAI(
    options as unknown as Parameters<typeof getAI>[0],
  ) as unknown as ReturnType<NonNullable<ResolveAIOptions['createClient']>>;
}

/** Completed when the released ChatGPT provider is adopted. */
async function defaultCreateChatGPTRuntime(): Promise<ChatGPTKitchenRuntime> {
  void openSystemBrowser;
  throw new KitchenInferenceError(
    'KITCHEN_CHATGPT_SDK_UNAVAILABLE',
    'Continue with ChatGPT requires the released @happyvertical/auth and @happyvertical/ai plan-usage provider.',
  );
}

function normalizeMode(
  value: string | undefined,
): KitchenInferenceMode | undefined {
  if (!value) return undefined;
  if (value === 'manual' || value === 'configured' || value === 'chatgpt') {
    return value;
  }
  throw new KitchenInferenceError(
    'KITCHEN_INFERENCE_OPTION',
    `Unknown inference mode "${value}". Choose manual, configured, or chatgpt.`,
  );
}

function validateModeOptions(
  mode: KitchenInferenceMode,
  selection: KitchenInferenceSelection,
): void {
  if (
    mode === 'manual' &&
    (selection.provider || selection.model || selection.account)
  ) {
    throw new KitchenInferenceError(
      'KITCHEN_INFERENCE_OPTION',
      '--provider, --model, and --account cannot be used with --inference manual.',
    );
  }
  if (mode === 'configured' && selection.account) {
    throw new KitchenInferenceError(
      'KITCHEN_INFERENCE_OPTION',
      '--account is only valid with --inference chatgpt.',
    );
  }
  if (mode === 'chatgpt' && selection.provider) {
    throw new KitchenInferenceError(
      'KITCHEN_INFERENCE_OPTION',
      '--provider is only valid with --inference configured.',
    );
  }
}

export function terminalPrompter(): KitchenPrompter {
  return {
    async select(message, choices) {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      try {
        process.stdout.write(`\n${message}\n`);
        choices.forEach((choice, index) => {
          process.stdout.write(
            `  ${index + 1}. ${choice.label}${choice.description ? ` — ${choice.description}` : ''}\n`,
          );
        });
        while (true) {
          let answer: string;
          try {
            answer = await rl.question('Choose a number: ', {
              signal: controller.signal,
            });
          } catch (error) {
            if (controller.signal.aborted) {
              throw new KitchenInferenceError(
                'KITCHEN_INFERENCE_CANCELLED',
                'Inference setup cancelled.',
              );
            }
            throw error;
          }
          const index = Number.parseInt(answer.trim(), 10) - 1;
          if (Number.isInteger(index) && choices[index]) {
            return choices[index].value;
          }
          process.stdout.write(`Enter a number from 1 to ${choices.length}.\n`);
        }
      } finally {
        process.off('SIGINT', cancel);
        rl.close();
      }
    },
  };
}

async function chooseMode(
  options: ResolveAIOptions,
): Promise<KitchenInferenceMode> {
  const selection = options.selection ?? {};
  const explicit = normalizeMode(selection.mode);
  if (explicit) {
    validateModeOptions(explicit, selection);
    return explicit;
  }
  if (!options.interactive) {
    throw new KitchenInferenceError(
      'KITCHEN_INFERENCE_REQUIRED',
      'Choose inference explicitly with --inference manual, --inference configured, or --inference chatgpt.',
    );
  }
  const prompt = options.prompt ?? terminalPrompter();
  const selected = normalizeMode(
    await prompt.select('How should Kitchen handle inference?', [
      {
        value: 'manual',
        label: 'Plan manually',
        description: 'No model, account authorization, or paid inference',
      },
      {
        value: 'chatgpt',
        label: 'Continue with ChatGPT',
        description:
          'Authorize use of an eligible ChatGPT plan in your system browser',
      },
      {
        value: 'configured',
        label: 'Use a configured provider',
        description:
          'Use API billing or a local endpoint from smrt.config.ts / SMRT_AI_*',
      },
    ]),
  );
  if (!selected) throw new Error('The inference prompt returned no selection.');
  validateModeOptions(selected, selection);
  return selected;
}

async function configuredAI(options: ResolveAIOptions): Promise<KitchenAI> {
  const selection = options.selection ?? {};
  const searchFrom =
    options.dir && existsSync(resolve(options.dir))
      ? resolve(options.dir)
      : process.cwd();
  await loadConfig({ searchFrom });
  const resolved = tryResolveConfiguredAIProvider({
    env: options.env,
    explicit: { provider: selection.provider, model: selection.model },
  });
  if (!resolved?.provider) {
    throw new KitchenInferenceError(
      'KITCHEN_AI_NOT_CONFIGURED',
      'Configured inference was selected, but no provider is set. Add an `ai` block to smrt.config.ts, set SMRT_AI_PROVIDER, or pass --provider. Local endpoints remain configured through the provider baseUrl setting.',
    );
  }
  const client = await (options.createClient ?? defaultCreateClient)(
    toAIClientOptions(resolved),
  );
  return {
    label: `${resolved.provider}${resolved.model ? ` (${resolved.model})` : ''}`,
    async chat(messages) {
      const response = await client.chat(messages);
      return response.content;
    },
  };
}

function accountLabel(account: ChatGPTAccount): string {
  return `${account.email ?? 'ChatGPT account'} (${account.clientId.slice(-8)})`;
}

async function chatGPTAI(options: ResolveAIOptions): Promise<KitchenAI> {
  const runtime = await (
    options.createChatGPTRuntime ?? defaultCreateChatGPTRuntime
  )();
  const selection = options.selection ?? {};
  const accounts = await runtime.sessions();
  let account: ChatGPTAccount | undefined;

  if (selection.account) {
    account = accounts.find(
      (candidate) => candidate.clientId === selection.account,
    );
    if (!account) {
      throw new KitchenInferenceError(
        'KITCHEN_CHATGPT_ACCOUNT_UNKNOWN',
        'The selected ChatGPT account registration is not saved on this host. Run interactively to add it or choose a listed registration.',
      );
    }
  } else if (options.interactive) {
    const prompt = options.prompt ?? terminalPrompter();
    const value = await prompt.select('Choose a ChatGPT account.', [
      ...accounts.map((candidate) => ({
        value: candidate.clientId,
        label: accountLabel(candidate),
        description: 'Use this saved account and workspace registration',
      })),
      ...accounts.map((candidate) => ({
        value: `__reauthorize__:${candidate.clientId}`,
        label: `Sign in again to ${accountLabel(candidate)}`,
        description:
          'Refresh a revoked session or grant plan-use permission in the system browser',
      })),
      {
        value: '__add__',
        label: 'Add a ChatGPT account',
        description:
          'Open the system browser for registration and explicit plan-use consent',
      },
    ]);
    if (value === '__add__') {
      account = await runtime.authorize();
    } else if (value.startsWith('__reauthorize__:')) {
      account = await runtime.authorize(value.slice('__reauthorize__:'.length));
    } else {
      account = accounts.find((candidate) => candidate.clientId === value);
    }
  } else {
    throw new KitchenInferenceError(
      'KITCHEN_CHATGPT_ACCOUNT_REQUIRED',
      'Choose a saved ChatGPT registration with --account, or run in a terminal to add or select an account.',
    );
  }

  if (!account) {
    throw new KitchenInferenceError(
      'KITCHEN_CHATGPT_ACCOUNT_UNKNOWN',
      'The selected ChatGPT account registration is unavailable.',
    );
  }

  const discovery = await runtime.createClient(account.clientId);
  let models: ChatGPTModel[];
  try {
    models = await discovery.getModels();
  } catch (error) {
    throw runtime.mapError(error) ?? error;
  }
  if (models.length === 0) {
    throw new KitchenInferenceError(
      'KITCHEN_CHATGPT_MODELS_UNAVAILABLE',
      'The selected ChatGPT account returned no models. Choose another account or restart Kitchen with another inference mode.',
    );
  }
  let model = selection.model;
  if (model && !models.some((candidate) => candidate.id === model)) {
    throw new KitchenInferenceError(
      'KITCHEN_CHATGPT_MODEL_UNKNOWN',
      `Model "${model}" is not available to the selected ChatGPT account.`,
    );
  }
  if (!model && options.interactive) {
    const prompt = options.prompt ?? terminalPrompter();
    model = await prompt.select(
      `Choose a model for ${accountLabel(account)}.`,
      models.map((candidate) => ({
        value: candidate.id,
        label: candidate.name ?? candidate.id,
        description:
          candidate.name && candidate.name !== candidate.id
            ? candidate.id
            : undefined,
      })),
    );
  }
  if (!model) {
    throw new KitchenInferenceError(
      'KITCHEN_CHATGPT_MODEL_REQUIRED',
      'Choose one of the selected account’s discovered models with --model, or run in a terminal to select it.',
    );
  }

  const selectedClient = await runtime.createClient(account.clientId, model);
  return {
    label: `ChatGPT ${accountLabel(account)} (${model})`,
    async chat(messages) {
      try {
        const response = await selectedClient.chat(messages);
        return response.content;
      } catch (error) {
        throw runtime.mapError(error) ?? error;
      }
    },
  };
}

/** Resolve exactly the inference mode the user selected. */
export async function resolveKitchenAI(
  options: ResolveAIOptions = {},
): Promise<KitchenAI | null> {
  const mode = await chooseMode(options);
  if (mode === 'manual') return null;
  if (mode === 'configured') return configuredAI(options);
  try {
    return await chatGPTAI(options);
  } catch (error) {
    if (
      !(error instanceof KitchenInferenceError) ||
      error.code !== 'KITCHEN_CHATGPT_CONSENT_DECLINED' ||
      !options.interactive
    ) {
      throw error;
    }
    const prompt = options.prompt ?? terminalPrompter();
    const fallback = await prompt.select(
      'ChatGPT authorization was declined. How should Kitchen continue?',
      [
        {
          value: 'manual',
          label: 'Continue manually',
          description: 'Keep planning without a model or paid inference',
        },
        {
          value: 'configured',
          label: 'Use a configured provider',
          description: 'Use API billing or a configured local endpoint',
        },
        {
          value: 'chatgpt',
          label: 'Try Continue with ChatGPT again',
          description: 'Open a new authorization attempt in the system browser',
        },
      ],
    );
    return resolveKitchenAI({
      ...options,
      selection: { mode: fallback },
    });
  }
}

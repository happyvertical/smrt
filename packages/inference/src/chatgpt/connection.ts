import { rankOpenAIWorkModels, strongestWorkModel } from '../work-profiles.js';
/**
 * "Sign in with ChatGPT" connection service (host-agnostic, Node-only).
 *
 * A local app lets its owner use their own ChatGPT plan through OpenAI's
 * official flow (a PREVIEW for open source apps):
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 *
 * The SDK owns everything sensitive. `LocalChatGPTSessionManager`
 * (`@happyvertical/auth/local`) runs the loopback callback, PKCE, dynamic
 * client registration and OIDC validation, and keeps the renewable
 * credentials in one owner-only file at `credentialsPath` (put it in the app's
 * private state area, never in a project). This service never reads that
 * file, and never logs, returns or copies a token: its results carry a
 * sign-in state and an account label, nothing else. The only thing that
 * reaches a provider is a minimal `{ accessToken(clientId) }` handle, so a
 * provider can ask for a usable token before a request and nothing more
 * (it cannot sign anyone out).
 *
 * This is a distinct billing path from an API key. It is never selected
 * automatically and never a fallback: a host opts in per call through
 * {@link createChatGPTPlanResolver}.
 */

/** The `@happyvertical/ai` provider id of this path. */
export const CHATGPT_PLAN_PROVIDER = 'chatgpt-plan';

/** The only host OpenAI's sign-in page may be served from. */
export const CHATGPT_AUTH_HOST = 'auth.openai.com';

/** How long a started sign-in is shown as "in progress". */
export const CHATGPT_SIGN_IN_WINDOW_MS = 10 * 60_000;

const MODELS_TTL_MS = 10 * 60_000;

/** The slice of `LocalChatGPTSessionManager` this service uses. */
export interface ChatGPTSessionStore {
  sessions(): Promise<
    ReadonlyArray<{
      clientId: string;
      subject: string;
      email?: string;
      scopes: string[];
      expiresAt: number;
    }>
  >;
  begin(selectedClientId?: string): Promise<{
    authorizationUrl: string;
    callback: Promise<{ clientId: string }>;
    /** SDK-owned cancellation and listener cleanup, when supported. */
    cancel?: () => Promise<void>;
  }>;
  accessToken(clientId: string): Promise<string>;
  logout(clientId: string): Promise<{ remoteRevocationConfirmed: boolean }>;
}

/** What the provider is given instead of the session manager. */
export interface ChatGPTTokenSource {
  accessToken(clientId: string): Promise<string>;
}

/** A model the signed-in account can use. */
export interface ChatGPTPlanModel {
  id: string;
  label: string;
  intelligenceRank?: number;
}

/** The slice of the provider this service uses. */
export interface ChatGPTPlanModelLister {
  getModels(): Promise<
    Array<{ id: string; name?: string; intelligenceRank?: number }>
  >;
}

export type ChatGPTSignInErrorCode =
  | 'declined'
  | 'plan_permission_missing'
  | 'storage_busy'
  | 'timed_out'
  | 'failed';

export interface ChatGPTPlanStatus {
  signedIn: boolean;
  /** Who is signed in: the account email, else a short subject label. */
  account?: { label: string };
  /** A sign-in was started and has neither finished nor timed out. */
  signingIn: boolean;
  /** Why the last sign-in did not finish. Cleared by the next start. */
  error?: { code: ChatGPTSignInErrorCode; message: string };
}

export interface ChatGPTPlanConnectionOptions {
  /**
   * The app name OpenAI shows on its page ("<name> wants to use your ChatGPT
   * plan").
   */
  appName: string;
  /**
   * The credential file, in the app's private state area (owner-only, outside
   * any source tree). Required: there is no default location.
   */
  credentialsPath: string;
  /** Tests: a fake session manager. Default: the SDK's local manager. */
  manager?: ChatGPTSessionStore;
  /** Tests: a fake provider factory. Default: `getAI({ type: 'chatgpt-plan' })`. */
  createClient?: (
    options: Record<string, unknown>,
  ) => Promise<ChatGPTPlanModelLister>;
  /** Tests: the clock. */
  now?: () => number;
}

export interface ChatGPTPlanConnection {
  /**
   * Start a sign-in. Returns the authorization URL on OpenAI's host (already
   * validated) for the host to open in the system browser; the SDK's loopback
   * listener receives the callback. A second call while one is open returns
   * the same URL.
   */
  start(): Promise<{ authorizationUrl: string }>;
  /** Signed in or not, and who. Never a token. */
  status(): Promise<ChatGPTPlanStatus>;
  /** Cancel the SDK's pending flow; refuses honestly when the SDK lacks this API. */
  cancel(): Promise<void>;
  /** Forget the local credentials (and ask OpenAI to revoke them). */
  signOut(): Promise<{ remoteRevocationConfirmed: boolean }>;
  /** The signed-in account's models, newest catalog (cached for ten minutes). */
  models(): Promise<ChatGPTPlanModel[]>;
  /** Strongest ranked model offered by this account, or undefined for an unknown catalog. */
  defaultModel(): Promise<string | undefined>;
  /**
   * `getAI()` options for a `chatgpt-plan` client on the signed-in account:
   * the client id and a token handle, plus `model` as `defaultModel`. These
   * hold a live handle, so they are never serialized or logged. Throws when
   * nobody is signed in.
   */
  clientOptions(options?: {
    model?: string;
    toolNamespace?: { name?: string; description?: string };
  }): Promise<Record<string, unknown>>;
}

export class ChatGPTSignedOutError extends Error {
  readonly code = 'chatgpt_signed_out';
  constructor() {
    super('Sign in with ChatGPT first.');
    this.name = 'ChatGPTSignedOutError';
  }
}

/**
 * Whether `url` is a sign-in page on OpenAI's host: https, that host, no
 * userinfo, no fragment. A host that opens a browser checks this first.
 */
export function isChatGPTAuthorizationUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === CHATGPT_AUTH_HOST &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

const MESSAGES: Record<ChatGPTSignInErrorCode, string> = {
  declined: 'Sign-in was declined in the browser.',
  plan_permission_missing:
    'ChatGPT did not allow plan use for this account. Check the account and try again.',
  storage_busy: 'Another sign-in is in progress. Try again in a moment.',
  timed_out: 'The sign-in was not finished in time. Try again.',
  failed: 'Sign-in did not finish. Try again.',
};

function errorFor(code: ChatGPTSignInErrorCode) {
  return { code, message: MESSAGES[code] };
}

/** Map the SDK's session error code (a fixed vocabulary) to ours. */
function signInErrorCode(error: unknown): ChatGPTSignInErrorCode {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'consent_declined') return 'declined';
  if (code === 'plan_permission_missing') return 'plan_permission_missing';
  if (code === 'storage_busy') return 'storage_busy';
  return 'failed';
}

/** Build the connection. Nothing is read or opened until first use. */
export function createChatGPTPlanConnection(
  options: ChatGPTPlanConnectionOptions,
): ChatGPTPlanConnection {
  if (!options.credentialsPath.trim())
    throw new Error('a ChatGPT credentials path is required');
  const now = options.now ?? Date.now;

  let managerPromise: Promise<ChatGPTSessionStore> | undefined;
  const manager = (): Promise<ChatGPTSessionStore> => {
    managerPromise ??= options.manager
      ? Promise.resolve(options.manager)
      : // Loaded lazily: the SDK's local runtime needs `node:sqlite`.
        import('@happyvertical/auth/local').then(
          ({ LocalChatGPTSessionManager }) =>
            new LocalChatGPTSessionManager({
              appName: options.appName,
              path: options.credentialsPath,
            }) as unknown as ChatGPTSessionStore,
        );
    managerPromise.catch(() => {
      managerPromise = undefined;
    });
    return managerPromise;
  };

  let pending:
    | { url: string; startedAt: number; cancel?: () => Promise<void> }
    | undefined;
  let lastError: ChatGPTPlanStatus['error'];
  let activeClientId: string | undefined;
  let modelCache:
    | { at: number; clientId: string; models: ChatGPTPlanModel[] }
    | undefined;

  const signingIn = () =>
    pending !== undefined &&
    now() - pending.startedAt < CHATGPT_SIGN_IN_WINDOW_MS;

  /** The account in use: the one just signed in, else the newest stored. */
  async function current() {
    const sessions = (await (await manager()).sessions()).filter((s) =>
      s.scopes.includes('chatgpt.tokens.use.direct'),
    );
    return (
      sessions.find((s) => s.clientId === activeClientId) ?? sessions.at(-1)
    );
  }

  async function dropOthers(keep: string) {
    try {
      const store = await manager();
      for (const session of await store.sessions())
        if (session.clientId !== keep)
          await store.logout(session.clientId).catch(() => undefined);
    } catch {
      // Cleanup of older registrations is best effort.
    }
  }

  const connection: ChatGPTPlanConnection = {
    async start() {
      if (pending && signingIn()) return { authorizationUrl: pending.url };
      lastError = undefined;
      const store = await manager();
      const begun = await store.begin();
      if (!isChatGPTAuthorizationUrl(begun.authorizationUrl)) {
        // Not OpenAI's page: never hand it to a browser. The SDK's loopback
        // listener closes on its own timeout.
        begun.callback.catch(() => undefined);
        throw new Error('The sign-in address was not on OpenAI.');
      }
      const mine = {
        url: begun.authorizationUrl,
        startedAt: now(),
        cancel: begun.cancel,
      };
      pending = mine;
      begun.callback.then(
        (session) => {
          if (
            pending !== mine ||
            now() - mine.startedAt >= CHATGPT_SIGN_IN_WINDOW_MS
          ) {
            void store.logout(session.clientId).catch(() => undefined);
            return;
          }
          pending = undefined;
          activeClientId = session.clientId;
          modelCache = undefined;
          // One registration per account: older ones are signed out.
          void dropOthers(session.clientId);
        },
        (error: unknown) => {
          if (pending !== mine) return;
          pending = undefined;
          lastError = errorFor(signInErrorCode(error));
        },
      );
      return { authorizationUrl: begun.authorizationUrl };
    },

    async status() {
      let session: Awaited<ReturnType<typeof current>>;
      try {
        session = await current();
      } catch {
        session = undefined;
      }
      if (!pending || !signingIn()) {
        if (pending && !lastError) lastError = errorFor('timed_out');
        pending = undefined;
      }
      return {
        signedIn: session !== undefined,
        ...(session
          ? { account: { label: session.email?.trim() || 'ChatGPT account' } }
          : {}),
        signingIn: signingIn(),
        ...(lastError && !session ? { error: lastError } : {}),
      };
    },

    async cancel() {
      const mine = pending;
      if (!mine) return;
      if (!mine.cancel)
        throw Object.assign(
          new Error('This auth SDK cannot cancel a pending sign-in'),
          { code: 'chatgpt_cancel_unavailable' },
        );
      await mine.cancel();
      if (pending === mine) pending = undefined;
      lastError = undefined;
    },

    async signOut() {
      pending = undefined;
      lastError = undefined;
      modelCache = undefined;
      activeClientId = undefined;
      const store = await manager();
      let confirmed = true;
      for (const session of await store.sessions()) {
        const out = await store.logout(session.clientId);
        confirmed = confirmed && out.remoteRevocationConfirmed;
      }
      return { remoteRevocationConfirmed: confirmed };
    },

    async clientOptions(extra = {}) {
      const session = await current();
      if (!session) throw new ChatGPTSignedOutError();
      const store = await manager();
      const tokens: ChatGPTTokenSource = {
        accessToken: (clientId) => store.accessToken(clientId),
      };
      return {
        type: CHATGPT_PLAN_PROVIDER,
        clientId: session.clientId,
        sessionManager: tokens,
        ...(extra.model ? { defaultModel: extra.model } : {}),
        ...(extra.toolNamespace ? { toolNamespace: extra.toolNamespace } : {}),
      };
    },

    async models() {
      const session = await current();
      if (!session) throw new ChatGPTSignedOutError();
      if (
        modelCache &&
        modelCache.clientId === session.clientId &&
        now() - modelCache.at < MODELS_TTL_MS
      )
        return modelCache.models;
      const clientOptions = await connection.clientOptions();
      const client = options.createClient
        ? await options.createClient(clientOptions)
        : ((await (
            await import('@happyvertical/ai')
          ).getAI(
            clientOptions as unknown as Parameters<
              typeof import('@happyvertical/ai')['getAI']
            >[0],
          )) as unknown as ChatGPTPlanModelLister);
      const models = rankOpenAIWorkModels(
        (await client.getModels()).map((m) => ({
          id: m.id,
          label: m.name?.trim() || m.id,
          ...(Number.isFinite(m.intelligenceRank)
            ? { intelligenceRank: m.intelligenceRank }
            : {}),
        })),
      );
      modelCache = { at: now(), clientId: session.clientId, models };
      return models;
    },

    async defaultModel() {
      return strongestWorkModel(await connection.models());
    },
  };
  return connection;
}

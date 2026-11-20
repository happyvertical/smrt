/**
 * The tracked client (#5005; docs/content/ai-runs.md section 3, "Staying on
 * the tracked path"): the one entry point for code that makes model calls
 * outside a `SmrtObject`.
 *
 * - **Scoped per tenant and database.** A tracked client is built for one
 *   database and one tenant. Its runs, reservations and usage rows are
 *   written there and nowhere else; nothing is kept per process.
 * - **The run is passed explicitly.** `client(prompt, { runContext })` binds
 *   one run's context to the returned client; nothing reads a run from an
 *   ambient variable.
 * - **Every call carries a prompt key.** A client is made for a prompt, so
 *   every call it sends is tagged with that prompt's key and template hash;
 *   a prompt without a key is refused ({@link AiPromptKeyRequiredError}).
 *   Core never imports `smrt-prompts`: the caller resolves the prompt there
 *   (`resolvePrompt`) and hands the key, and `smrt-prompts` supplies
 *   `trackedPromptOptions()` to turn a resolution into the input below.
 *
 * Calls on the returned client go through the same pipeline as
 * `SmrtClass#getAiClient(tier, { runTracking: true })`: a call that belongs
 * to a run is reserved, sent under its own call id and settled with its usage
 * row; one that does not is an ordinary single call.
 */

import type { AIClient, AIClientOptions } from '@happyvertical/ai';
import type { DatabaseInterface } from '@happyvertical/sql';
import { SmrtClass, type SmrtClassOptions } from './class.js';
import type { AiUsageConfig } from './config.js';
import type {
  InferenceConfig,
  InferenceLatency,
  InferenceResolver,
  InferenceTier,
  InferenceTierRequest,
} from './inference.js';
import { SmrtError } from './smrt-error.js';
import { type AiRunContext, isAiRunContext } from './system/ai-run-calls.js';
import {
  type AiRunStore,
  type OpenAiRunInput,
  openAiRun,
} from './system/ai-run-lifecycle.js';
import { type AiRunRow, aiRunQuery, getRows } from './system/ai-run-model.js';

/** A tracked call was set up without a prompt key. */
export class AiPromptKeyRequiredError extends SmrtError {
  constructor(details?: Record<string, unknown>) {
    super(
      'A tracked AI call needs the key of a registered prompt: resolve the prompt through resolvePrompt() and pass its key',
      'AI_PROMPT_KEY_REQUIRED',
      'configuration',
      details,
    );
  }
}

/** What a tracked client is scoped to. */
export interface TrackedAiClientOptions {
  /** The tenant's database: runs and usage rows are written here. */
  db: DatabaseInterface;
  /** The tenant the work belongs to; `null` is the global scope. */
  tenantId?: string | null;
  /** Recorded as the usage rows' class name. */
  className?: string;
  /** The provider client (options, or a client the host already built). */
  ai?: AIClientOptions | AIClient;
  /**
   * What a client the host already built is recorded as on its calls' usage
   * rows when its configuration does not say: the provider (an inference
   * engine such as `chatgpt`) and the model it was bound to. A model the
   * response reports wins over `model`. Ignored for a provider the options
   * name.
   */
  label?: { provider: string; model?: string };
  inference?: InferenceConfig | InferenceResolver;
  usage?: AiUsageConfig;
  /**
   * The transcript directive of every call (#4780, only while the app
   * enables transcripts): `false` for a host that stores the conversation
   * itself and wants no second copy. Omitted, successes are sampled.
   */
  transcript?: boolean;
}

/**
 * The prompt a tracked client is made for. `promptKey` is required; the rest
 * is what a resolved prompt asks for (`smrt-prompts` fills it in).
 */
export interface TrackedPromptCall {
  /** The registered prompt's key. */
  promptKey: string;
  /** The prompt version (`usageTags.templateHash`). */
  templateHash?: string;
  tier?: InferenceTierRequest;
  latency?: InferenceLatency;
  minimumTier?: InferenceTier;
  /** Merged under the call's own tags. */
  usageTags?: Record<string, string>;
}

/** A run opened through the tracked client. */
export interface TrackedAiRun {
  run: AiRunRow;
  /** Pass it as `runContext`, or to `client(prompt, { runContext })`. */
  context: AiRunContext;
}

/** The tracked client of one tenant and database. */
export interface TrackedAiClient {
  readonly db: DatabaseInterface;
  readonly tenantId: string | null;
  /**
   * Open a run on this database and tenant. Throws
   * `AiRunTrackingDisabledError` while usage persistence is off.
   */
  openRun(input: OpenAiRunInput): Promise<TrackedAiRun>;
  /**
   * A client for one prompt. Every call on it is tagged with the prompt's key
   * and template hash, and belongs to `runContext` when one is given.
   */
  client(
    prompt: TrackedPromptCall,
    options?: { runContext?: AiRunContext },
  ): Promise<AIClient>;
}

/**
 * The runtime that builds the tracked client. It is a helper, not a model: a
 * class expression, because the manifest scanner registers every class
 * declaration that extends `SmrtClass` as a persisted model (and so a table).
 */
const TrackedAiHost = class extends SmrtClass {
  readonly tenantId: string | null;
  private readonly transcript: boolean | undefined;

  constructor(options: TrackedAiClientOptions) {
    const { tenantId, className, transcript, label, ...rest } = options;
    super({
      ...(rest as SmrtClassOptions),
      _className: className ?? 'TrackedAiClient',
    } as SmrtClassOptions);
    this.tenantId = tenantId ?? null;
    this.transcript = transcript;
    if (label) this._aiClientLabel = { ...label };
  }

  ready(): Promise<this> {
    return this.initialize();
  }

  store(): Promise<AiRunStore> {
    return this.aiRunStore();
  }

  async tracked(prompt: TrackedPromptCall): Promise<AIClient> {
    const client = await this.getAiClient(prompt.tier, {
      runTracking: true,
      promptKey: prompt.promptKey,
      ...(prompt.latency ? { latency: prompt.latency } : {}),
      ...(prompt.minimumTier ? { minimumTier: prompt.minimumTier } : {}),
    });
    return this.transcript === undefined
      ? client
      : this.transcriptClient(client, this.transcript);
  }
};
type TrackedAiHost = InstanceType<typeof TrackedAiHost>;

const TRACKED_METHODS = new Set(['message', 'chat', 'complete', 'stream']);

/**
 * Create the tracked client of one tenant and database. Cheap: nothing is
 * read or opened until a run or a client is asked for.
 */
export function createTrackedAiClient(
  options: TrackedAiClientOptions,
): TrackedAiClient {
  if (!options?.db || typeof options.db.query !== 'function') {
    throw new TypeError('createTrackedAiClient: a database is required');
  }
  // The database is captured once: the caller's options object may be
  // changed afterwards, and validation, contexts and persistence must all
  // keep naming the database the host was built on.
  const db = options.db;
  const host = new TrackedAiHost(options);
  let ready: Promise<TrackedAiHost> | undefined;
  const initialized = () => {
    ready ??= host.ready().catch((error) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };
  const tenantId = options.tenantId ?? null;
  /**
   * A run context is accepted only on this client's database and tenant:
   * the context's declared tenant and its run row's tenant (global `null`
   * included) must both be this client's. Applied to a context bound at
   * `client()` and to one passed on a single call. The context is copied
   * before anything is awaited and only the copy is checked and used, so a
   * caller changing the object afterwards cannot move the call to another
   * run.
   */
  const inScope = async (runContext: unknown): Promise<AiRunContext> => {
    // Each property is read once, into a plain copy, and only the copy is
    // checked: a getter cannot answer the check and the use differently.
    const copy: unknown =
      runContext !== null && typeof runContext === 'object'
        ? { ...runContext }
        : runContext;
    if (!isAiRunContext(copy)) {
      throw new TypeError('client: runContext is not an AI run context');
    }
    const checked: AiRunContext = copy;
    const refuse = () =>
      new TypeError('client: the run belongs to another tenant or database');
    if (checked.db !== db || (checked.tenantId ?? null) !== tenantId) {
      throw refuse();
    }
    // Looked up in the client's tenant (a SQL predicate): a run of another
    // tenant is not read, only not found.
    const owned = getRows(
      await aiRunQuery(
        db,
        `SELECT id FROM _smrt_ai_runs WHERE id = $1 AND ${
          tenantId === null ? 'tenant_id IS NULL' : 'tenant_id = $2'
        }`,
        checked.runId,
        ...(tenantId === null ? [] : [tenantId]),
      ),
    );
    if (owned.length === 0) throw refuse();
    // The accepted copy names the client's tenant, an explicit `null`
    // included: accounting never looks a context's tenant up again.
    checked.tenantId = tenantId;
    return checked;
  };
  return {
    db,
    tenantId,
    async openRun(input) {
      await initialized();
      const store = await host.store();
      const run = await openAiRun(store, input);
      return {
        run,
        context: { runId: run.id, db, tenantId: run.tenantId },
      };
    },
    async client(prompt, callOptions = {}) {
      if (
        !prompt ||
        typeof prompt.promptKey !== 'string' ||
        prompt.promptKey.trim() === ''
      ) {
        throw new AiPromptKeyRequiredError();
      }
      const runContext =
        callOptions.runContext !== undefined
          ? await inScope(callOptions.runContext)
          : undefined;
      await initialized();
      const inner = await host.tracked(prompt);
      const tags: Record<string, string> = {
        ...(prompt.usageTags ?? {}),
        promptKey: prompt.promptKey,
        ...(prompt.templateHash ? { templateHash: prompt.templateHash } : {}),
      };
      return new Proxy(inner as object, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== 'function' || typeof property !== 'string') {
            return value;
          }
          if (!TRACKED_METHODS.has(property)) return value.bind(target);
          // The call's options are read once, into a plain copy, before
          // anything is checked: the run context that is checked is the
          // one forwarded, and a context the caller passed is never
          // forwarded itself, only its checked copy.
          const snapshot = (raw: unknown): Record<string, unknown> =>
            raw !== null && typeof raw === 'object' ? { ...raw } : {};
          const send = (
            input: unknown,
            options: Record<string, unknown>,
            rest: unknown[],
            context: AiRunContext | undefined = runContext,
          ) => {
            const { runContext: _passed, ...forwarded } = options;
            return value.call(
              target,
              input,
              {
                ...forwarded,
                usageTags: {
                  ...tags,
                  ...((forwarded.usageTags as
                    | Record<string, string>
                    | undefined) ?? {}),
                  // The prompt's key is not the call's to change.
                  promptKey: prompt.promptKey,
                },
                ...(context ? { runContext: context } : {}),
              },
              ...rest,
            );
          };
          // A context bound at `client()` was checked there; one passed on
          // the call is checked before anything is reserved or sent.
          const perCall = (options: Record<string, unknown>) =>
            !runContext && options.runContext !== undefined;
          if (property === 'stream') {
            return (input: unknown, raw?: unknown, ...rest: unknown[]) => {
              const options = snapshot(raw);
              if (!perCall(options)) return send(input, options, rest);
              // Copied now: the stream body runs at its first read.
              const passed =
                options.runContext !== null &&
                typeof options.runContext === 'object'
                  ? { ...options.runContext }
                  : options.runContext;
              return (async function* () {
                const context = await inScope(passed);
                yield* send(
                  input,
                  options,
                  rest,
                  context,
                ) as AsyncIterable<unknown>;
              })();
            };
          }
          return async (input: unknown, raw?: unknown, ...rest: unknown[]) => {
            const options = snapshot(raw);
            if (!perCall(options)) return send(input, options, rest);
            const context = await inScope(options.runContext);
            return send(input, options, rest, context);
          };
        },
      }) as AIClient;
    },
  };
}

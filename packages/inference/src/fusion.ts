/**
 * Consumer-defined fusions (#4753): the interpreter for `{ fusion: '<key>' }`
 * tier targets. SMRT ships the interpreter and the vocabulary, never a
 * fusion: modes are code, fusions are config.
 *
 * Each seat is a registered prompt key (its resolved template is the seat's
 * instructions) run on a target through the chain executor
 * ({@link createChainClient}), so alias chains, classified fallback and the
 * ladder apply per seat, and every seat's usage row comes from core's usage
 * pipeline tagged `runId`, `fusionKey` and `seat`. The run itself is one
 * `_smrt_ai_runs` row through `context.recordRun()`.
 *
 * Model calls per mode are fixed: `single` 1, `pair` 3, `handoff` 2. A gate
 * adds one typed-decision call and can only remove the remaining stage
 * (recorded `skipped`); a seat's fallback candidates are substitutions of
 * that seat, recorded in its tags, not extra seats.
 *
 * Like the executor, this module imports no SDK: tests drive it with fake
 * clients through `context.clientFor()`.
 */
import {
  type InferenceCallOptions,
  type InferenceCapabilityFallbackOption,
  type InferenceExecutionContext,
  type InferenceExecutor,
  type InferenceFusionDefinition,
  type InferenceFusionGate,
  type InferenceFusionSeat,
  type InferenceModelClient,
  type InferenceResolution,
  type InferenceRunStatus,
  type InferenceTarget,
  type InferenceTier,
  InferenceUnavailableError,
  importOptionalDependency,
  inferenceTargetKind,
  resolveAutoTier,
} from '@happyvertical/smrt-core';
import { classifyInferenceFailure, isInferenceAbort } from './classify.js';
import {
  candidateLabel,
  EXECUTOR_KINDS,
  FUSION_GATE_CONTINUE,
  FUSION_GATE_SEAT,
  findFusionDefinitionIssues,
  findFusionDefinitionPromptIssues,
} from './config.js';
import {
  InferenceConfigError,
  InferenceExhaustedError,
  InferenceFusionError,
} from './errors.js';
import { type ChainExecutorOptions, createChainClient } from './executor.js';
import { fusionStore, lookupFusion } from './fusion-store.js';
import type { InferenceSubstitution } from './types.js';

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/** Input to {@link defineFusion}: a definition plus its key. */
export interface DefineFusionInput extends InferenceFusionDefinition {
  key: string;
}

/**
 * Register a fusion in the process registry. Throws
 * {@link InferenceConfigError} naming every offender by path
 * (`fusions.<key>...`), including a seat whose prompt key no
 * `definePrompt()` registered (define prompts first). Alias references are
 * checked when the fusion runs, against the config of that call. Same
 * definition again is a no-op; a different one under the same key throws.
 * `inference.fusions.<key>` in app config wins over a registered fusion.
 */
export function defineFusion(
  input: DefineFusionInput,
): InferenceFusionDefinition {
  const key = typeof input?.key === 'string' ? input.key.trim() : '';
  if (!key) {
    throw new InferenceConfigError([
      {
        path: 'fusions',
        code: 'fusion-invalid',
        message: 'defineFusion() needs a non-empty key',
      },
    ]);
  }
  const { key: _key, ...definition } = input;
  const path = `fusions.${key}`;
  // Aliases are app config, unknown here: they are checked at run time.
  const issues = findFusionDefinitionIssues(definition, path, undefined).filter(
    (issue) => issue.code !== 'alias-unknown',
  );
  issues.push(...findFusionDefinitionPromptIssues(definition, path));
  if (issues.length > 0) throw new InferenceConfigError(issues);

  const store = fusionStore();
  const existing = store.get(key);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(definition)) {
      throw new InferenceConfigError([
        {
          path,
          code: 'fusion-invalid',
          message: `fusion "${key}" is already defined with a different definition`,
        },
      ]);
    }
    return existing;
  }
  const frozen = structuredClone(definition) as InferenceFusionDefinition;
  store.set(key, frozen);
  return frozen;
}

/** The registered (code-defined) fusion for `key`, if any. */
export function getFusion(key: string): InferenceFusionDefinition | undefined {
  return fusionStore().get(key);
}

/** Registered fusion keys. */
export function listFusions(): string[] {
  return [...fusionStore().keys()];
}

/** Remove every registered fusion (tests). */
export function clearFusions(): void {
  fusionStore().clear();
}

// ---------------------------------------------------------------------------
// Seat prompts
// ---------------------------------------------------------------------------

/** A seat's resolved instructions. */
export interface FusionSeatPrompt {
  /** The rendered template, sent as the seat's system message. */
  instructions: string;
  /** `promptKey`, `promptLayer`, `templateHash` (#4751). */
  usageTags?: Record<string, string>;
  /** Prompt-level defaults (`temperature`, `maxTokens`); the seat wins. */
  params?: Record<string, unknown>;
}

/** Resolves a seat's prompt key; the default uses smrt-prompts. */
export type FusionPromptResolver = (
  key: string,
  options: { tenantId?: string | null; db?: unknown },
) => Promise<FusionSeatPrompt>;

const RESOLVER_KEY = Symbol.for('smrt.inference.fusionPromptResolver');

type ResolverHolder = { [RESOLVER_KEY]?: FusionPromptResolver };

/**
 * Replace the seat prompt resolver (tests, or hosts that bundle without
 * `@happyvertical/smrt-prompts` resolvable at runtime). `undefined` restores
 * the default.
 */
export function setFusionPromptResolver(
  resolver: FusionPromptResolver | undefined,
): void {
  const holder = globalThis as ResolverHolder;
  if (resolver) holder[RESOLVER_KEY] = resolver;
  else delete holder[RESOLVER_KEY];
}

interface PromptsModule {
  resolvePrompt(
    key: string,
    options: { tenantId?: string | null; db?: unknown },
  ): Promise<{
    text: string;
    ai: {
      usageTags?: Record<string, string>;
      temperature?: number;
      maxTokens?: number;
    };
  }>;
}

/**
 * Default resolver: smrt-prompts' `resolvePrompt()` (code default, config,
 * app and tenant overrides), loaded without a static edge so this entry
 * stays browser-safe (smrt-prompts pulls in smrt-config and the SDKs).
 */
const PROMPTS_SPECIFIER = '@happyvertical/smrt-prompts';

async function loadPrompts(): Promise<PromptsModule> {
  try {
    // Resolved from this package (a dependency), so strict layouts
    // (no hoisting, PnP) find it. A variable specifier keeps
    // bundlers from following it into the browser-safe graph.
    const specifier = PROMPTS_SPECIFIER;
    return (await import(/* @vite-ignore */ specifier)) as PromptsModule;
  } catch {
    // Bundled builds: a module registered with core's
    // registerOptionalDependency(), else core's actionable error.
    return (await importOptionalDependency(
      PROMPTS_SPECIFIER,
      'Fusion seats resolve prompts through @happyvertical/smrt-prompts; install it, register it with registerOptionalDependency(), or call setFusionPromptResolver().',
    )) as PromptsModule;
  }
}

const defaultPromptResolver: FusionPromptResolver = async (key, options) => {
  const prompts = await loadPrompts();
  const resolved = await prompts.resolvePrompt(key, {
    ...(options.tenantId !== undefined ? { tenantId: options.tenantId } : {}),
    ...(options.db ? { db: options.db } : {}),
  });
  const params: Record<string, unknown> = {};
  if (typeof resolved.ai.temperature === 'number') {
    params.temperature = resolved.ai.temperature;
  }
  if (typeof resolved.ai.maxTokens === 'number') {
    params.maxTokens = resolved.ai.maxTokens;
  }
  return {
    instructions: resolved.text,
    ...(resolved.ai.usageTags ? { usageTags: resolved.ai.usageTags } : {}),
    params,
  };
};

function promptResolver(): FusionPromptResolver {
  return (globalThis as ResolverHolder)[RESOLVER_KEY] ?? defaultPromptResolver;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Token totals observed for one seat. */
export interface FusionSeatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Sum of recorded estimates; absent when no event carried one. */
  estimatedCost?: number;
}

/** How one seat went. */
export type FusionSeatStatus = 'ok' | 'failed' | 'skipped' | 'not-run';

/** One seat of a {@link FusionRunResult}. */
export interface FusionSeatResult {
  /** Persona: the seat name (default the prompt key). */
  name: string;
  prompt: string;
  status: FusionSeatStatus;
  /** Target label: `tier:<tier>`, `alias:<name>`, `candidates`, `provider/model`. */
  target: string;
  /** The candidate that answered (`provider/model`, `default`, ...). */
  model?: string;
  /** The seat's text (text seats, and JSON seats that parsed). */
  text?: string;
  /** A JSON seat's parsed value. */
  json?: unknown;
  /**
   * A JSON seat whose text did not parse keeps the text here (never
   * dropped), with the parse error in `parseError`.
   */
  raw?: string;
  parseError?: string;
  /** Why a seat died: failure class (or `unclassified`) and message. */
  failure?: { reason: string; message: string; code?: string };
  substitutions?: InferenceSubstitution[];
  usage?: FusionSeatUsage;
  durationMs?: number;
}

/** The decision gate's verdict. */
export interface FusionGateResult {
  /**
   * `sufficient` skipped the remaining stage; `insufficient` ran it;
   * `unavailable` (no decision client) and `error` ran it too; `not-run`
   * when no output existed to judge.
   */
  status: 'sufficient' | 'insufficient' | 'unavailable' | 'error' | 'not-run';
  choice?: string;
  confidence?: number;
  /** Decision provider and model. */
  model?: string;
  message?: string;
}

/** A finished (or failed) fusion run. */
export interface FusionRunResult {
  runId: string;
  fusionKey: string;
  mode: InferenceFusionDefinition['mode'];
  status: InferenceRunStatus;
  /** The answer: the final seat's text (see the mode rules). */
  text: string;
  seats: FusionSeatResult[];
  gate?: FusionGateResult;
  durationMs: number;
}

/**
 * Per-call options a fusion client reads (and strips) besides the usual
 * `ai.message()` options, which reach the final seat.
 */
export interface FusionCallOptions {
  /** Receives the structured result (per-seat outputs, `raw` JSON text). */
  onFusionResult?: (result: FusionRunResult) => void;
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

/** Caller tags that describe the entry call, not a seat's own call. */
const ENTRY_TAGS = new Set([
  'promptKey',
  'promptLayer',
  'templateHash',
  'tierRequested',
  'tierResolved',
  'substitutions',
  'runId',
  'fusionKey',
  'seat',
]);

/** Caller options that apply to every seat (transport, not generation). */
const TRANSPORT_OPTIONS = ['signal', 'timeout'] as const;

const MAX_MESSAGE = 300;

function seatName(seat: InferenceFusionSeat): string {
  return (seat.name ?? seat.prompt).trim();
}

function targetLabel(target: InferenceFusionSeat['target']): string {
  if (typeof target === 'string') return `tier:${target}`;
  const kind = inferenceTargetKind(target);
  if (kind === 'alias') return `alias:${String(target.alias)}`;
  if (kind === 'candidates') return 'candidates';
  return candidateLabel({
    ...(typeof target.provider === 'string'
      ? { provider: target.provider }
      : {}),
    ...(typeof target.model === 'string' ? { model: target.model } : {}),
  });
}

function shortMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_MESSAGE
    ? `${message.slice(0, MAX_MESSAGE)}…`
    : message;
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function parseSubstitutions(
  value: unknown,
): InferenceSubstitution[] | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function newRunId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** What a seat hands the next stage: its text, or its raw text. */
function seatOutputText(seat: FusionSeatResult): string {
  if (seat.raw !== undefined) return seat.raw;
  return seat.text ?? '';
}

function seatHeading(seat: FusionSeatResult): string {
  return `seat "${seat.name}" (${seat.model ?? seat.target})`;
}

/** One labelled block of a prior seat for a merge or answer seat. */
function describeSeat(seat: FusionSeatResult, role: string): string {
  if (seat.status === 'failed') {
    const failure = seat.failure;
    return `--- ${role} ${seatHeading(seat)} FAILED (${failure?.reason ?? 'unclassified'}): ${failure?.message ?? 'no answer'} ---\nThis seat produced no output; answer from the other material.`;
  }
  const note =
    seat.raw !== undefined
      ? ' (asked for JSON; the reply did not parse, raw text follows)'
      : '';
  return `--- ${role} ${seatHeading(seat)}${note} ---\n${seatOutputText(seat)}\n--- end of ${seat.name} ---`;
}

class FusionRun {
  private readonly runId = newRunId();
  private readonly seats: FusionSeatResult[];
  private readonly usage = new Map<string, FusionSeatUsage>();
  private gate: FusionGateResult | undefined;
  private readonly started: number;
  private readonly callerTags: Record<string, string>;
  private readonly finalOptions: Record<string, unknown>;
  private readonly transport: Record<string, unknown>;
  private readonly signal: AbortSignal | undefined;
  private readonly entryPromptKey: string | undefined;

  constructor(
    private readonly context: InferenceExecutionContext,
    private readonly key: string,
    private readonly definition: InferenceFusionDefinition,
    callerOptions: InferenceCallOptions,
    private readonly options: Required<ChainExecutorOptions>,
  ) {
    this.started = options.now();
    const { usageTags, model: _model, ...rest } = callerOptions;
    this.callerTags = Object.fromEntries(
      Object.entries(usageTags ?? {}).filter(([tag]) => !ENTRY_TAGS.has(tag)),
    );
    this.finalOptions = rest;
    this.transport = {};
    for (const name of TRANSPORT_OPTIONS) {
      if (rest[name] !== undefined) this.transport[name] = rest[name];
    }
    this.signal = rest.signal as AbortSignal | undefined;
    // The entry call's prompt: the resolver request's, else its usage tag.
    this.entryPromptKey =
      context.request.promptKey ??
      (typeof usageTags?.promptKey === 'string' && usageTags.promptKey !== ''
        ? usageTags.promptKey
        : undefined);
    this.seats = definition.seats.map((seat) => ({
      name: seatName(seat),
      prompt: seat.prompt,
      status: 'not-run',
      target: targetLabel(seat.target),
    }));
  }

  /** Resolve a seat's target into the context its chain runs in. */
  private async seatContext(
    seat: InferenceFusionSeat,
    index: number,
    track: (target: InferenceTarget, options: InferenceCallOptions) => void,
  ): Promise<InferenceExecutionContext> {
    const { context } = this;
    let resolution: InferenceResolution;
    let config = context.config;
    let tier: InferenceTier = context.resolution.tierResolved;
    const resolveTier = (next: InferenceTier) =>
      context.resolveTier(next, { promptKey: seat.prompt });
    if (typeof seat.target === 'string') {
      tier =
        seat.target === 'auto' ? resolveAutoTier(context.config) : seat.target;
      resolution = await resolveTier(tier);
      if (resolution.unavailable) {
        // #4757: this seat's tier may not run for the principal; the seat
        // dies (never falls back to the configured client).
        throw new InferenceUnavailableError({
          reason: resolution.unavailable,
          ...(resolution.mode ? { mode: resolution.mode } : {}),
          tier: resolution.tierResolved,
          owner: `fusion "${this.key}" seat "${seatName(seat)}"`,
        });
      }
    } else {
      // An alias, candidates or inline model: no ladder (the seat named
      // what it runs), recorded under the fusion's tier.
      resolution = {
        tierResolved: tier,
        target: { ...seat.target },
        via: 'config',
      };
      config = { ...(context.config ?? {}), degrade: false };
    }
    if (inferenceTargetKind(resolution.target) === 'fusion') {
      throw new InferenceConfigError([
        {
          path: `fusions.${this.key}.seats[${index}].target`,
          code: 'fusion-nested',
          message: `fusion "${this.key}" seat "${seatName(seat)}" resolved tier "${resolution.tierResolved}" to another fusion; a seat never runs a fusion`,
        },
      ]);
    }
    return {
      ...context,
      request: { ...context.request, tier, promptKey: seat.prompt },
      resolution,
      config,
      resolveTier,
      // Fusion seats never stream partial answers into each other.
      allowPartial: false,
      clientFor: async (target) => {
        const client = await context.clientFor(target);
        return {
          ...client,
          message: async (text: string, callOptions?: InferenceCallOptions) => {
            const answer = await client.message(text, callOptions);
            track(target, callOptions ?? {});
            return answer;
          },
        } as InferenceModelClient;
      },
    };
  }

  /**
   * Run one seat. A model failure kills the seat (recorded, never thrown);
   * a config error, a caller abort, or a final seat that already streamed
   * text rethrows.
   */
  private async runSeat(
    index: number,
    input: string,
    final: boolean,
  ): Promise<FusionSeatResult> {
    const seat = this.definition.seats[index] as InferenceFusionSeat;
    const result = this.seats[index] as FusionSeatResult;
    const started = this.options.now();
    let answered: { target: InferenceTarget; tags: Record<string, string> } = {
      target: {},
      tags: {},
    };
    let options: InferenceCallOptions = {};
    result.status = 'ok';
    try {
      // Setup failures (a prompt override read, a seat tier's resolver) kill
      // this seat like a model failure; only config errors and aborts end
      // the run.
      const prompt = await promptResolver()(seat.prompt, {
        ...(this.context.request.tenantId !== undefined
          ? { tenantId: this.context.request.tenantId }
          : {}),
        ...(this.context.db ? { db: this.context.db } : {}),
      });
      const seatContext = await this.seatContext(
        seat,
        index,
        (target, opts) => {
          answered = { target, tags: opts.usageTags ?? {} };
        },
      );
      const chain = createChainClient(seatContext, this.options);
      const passed = final ? this.finalOptions : this.transport;
      options = {
        ...(prompt.params ?? {}),
        ...passed,
        ...(seat.temperature !== undefined
          ? { temperature: seat.temperature }
          : {}),
        // A JSON seat on a candidate without JSON mode runs in text and
        // takes the raw recovery path below (#4758), instead of skipping
        // the candidate.
        ...(seat.output === 'json'
          ? {
              responseFormat: { type: 'json_object' },
              capabilityFallback: {
                ...((passed.capabilityFallback as
                  | InferenceCapabilityFallbackOption
                  | undefined) ?? {}),
                json: 'text',
              },
            }
          : {}),
        history: [{ role: 'system', content: prompt.instructions }],
        usageTags: {
          ...this.callerTags,
          ...(prompt.usageTags ?? {}),
          promptKey: seat.prompt,
          runId: this.runId,
          fusionKey: this.key,
          seat: result.name,
        },
      };
      const text = await chain.message(input, options);
      const target = answered.target;
      result.model = candidateLabel({
        ...(typeof target.provider === 'string'
          ? { provider: target.provider }
          : {}),
        ...(typeof target.model === 'string'
          ? { model: target.model }
          : typeof options.model === 'string'
            ? { model: options.model }
            : {}),
      });
      const substitutions = parseSubstitutions(answered.tags.substitutions);
      if (substitutions) result.substitutions = substitutions;
      if (seat.output === 'json') {
        try {
          result.json = JSON.parse(text);
          result.text = text;
        } catch (error) {
          result.raw = text;
          result.parseError = shortMessage(error);
        }
      } else {
        result.text = text;
      }
    } catch (error) {
      if (
        error instanceof InferenceConfigError ||
        isInferenceAbort(error) ||
        (final &&
          error instanceof InferenceExhaustedError &&
          error.reason === 'partial')
      ) {
        result.status = 'failed';
        result.failure = {
          reason:
            error instanceof InferenceExhaustedError
              ? error.reason
              : error instanceof InferenceConfigError
                ? 'config'
                : 'aborted',
          message: shortMessage(error),
        };
        throw error;
      }
      result.status = 'failed';
      const code = errorCode(error);
      result.failure = {
        reason:
          error instanceof InferenceExhaustedError
            ? error.reason
            : (classifyInferenceFailure(error) ?? 'unclassified'),
        message: shortMessage(error),
        ...(code ? { code } : {}),
      };
      if (error instanceof InferenceExhaustedError) {
        result.substitutions = error.substitutions;
      }
    } finally {
      result.durationMs = Math.max(0, this.options.now() - started);
    }
    return result;
  }

  /** The gate: one typed-decision call over the outputs so far. */
  private async runGate(
    gate: InferenceFusionGate,
    input: string,
    outputs: FusionSeatResult[],
  ): Promise<FusionGateResult> {
    const live = outputs.filter((seat) => seat.status === 'ok');
    if (live.length === 0) return { status: 'not-run' };
    if (!this.context.decide) return { status: 'unavailable' };
    const choice = gate.sufficientWhen.choice;
    try {
      const result = await this.context.decide(
        {
          state: {
            input,
            outputs: live.map((seat) => ({
              seat: seat.name,
              model: seat.model ?? seat.target,
              text: seatOutputText(seat),
            })),
          },
          questions: {
            gate: {
              type: 'choice',
              instructions: gate.criteria,
              criteria: {
                [choice]:
                  'The outputs so far already satisfy the instructions; the remaining stage is not needed.',
                [FUSION_GATE_CONTINUE]: 'The remaining stage is still needed.',
              },
            },
          },
        },
        {
          usageTags: {
            ...this.callerTags,
            runId: this.runId,
            fusionKey: this.key,
            seat: FUSION_GATE_SEAT,
          },
          ...(this.signal ? { signal: this.signal } : {}),
        },
      );
      if (!result) return { status: 'unavailable' };
      const answer = result.answers.gate;
      if (!answer || answer.type !== 'choice') {
        return {
          status: 'error',
          message: 'decision provider returned no choice for the gate',
        };
      }
      const sufficient =
        answer.choice === choice &&
        answer.confidence >= gate.sufficientWhen.minConfidence;
      return {
        status: sufficient ? 'sufficient' : 'insufficient',
        choice: answer.choice,
        confidence: answer.confidence,
        model: `${result.provenance.provider}/${result.provenance.model}`,
      };
    } catch (error) {
      if (isInferenceAbort(error)) throw error;
      return { status: 'error', message: shortMessage(error) };
    }
  }

  private skip(index: number): void {
    const seat = this.seats[index] as FusionSeatResult;
    seat.status = 'skipped';
  }

  private firstLive(...indices: number[]): FusionSeatResult | undefined {
    return indices
      .map((index) => this.seats[index] as FusionSeatResult)
      .find((seat) => seat.status === 'ok');
  }

  private async interpret(input: string): Promise<string | undefined> {
    const { definition } = this;
    if (definition.mode === 'single') {
      const seat = await this.runSeat(0, input, true);
      return seat.status === 'ok' ? seatOutputText(seat) : undefined;
    }
    if (definition.mode === 'pair') {
      // Settle both before rethrowing a config error or abort, so the run
      // record never misses a seat that was still spending.
      const settled = await Promise.allSettled([
        this.runSeat(0, input, false),
        this.runSeat(1, input, false),
      ]);
      const rejected = settled.find((entry) => entry.status === 'rejected');
      if (rejected) throw rejected.reason;
      const [first, second] = settled.map(
        (entry) => (entry as PromiseFulfilledResult<FusionSeatResult>).value,
      ) as [FusionSeatResult, FusionSeatResult];
      if (first.status !== 'ok' && second.status !== 'ok') return undefined;
      if (definition.gate) {
        this.gate = await this.runGate(definition.gate, input, [first, second]);
        if (this.gate.status === 'sufficient') {
          this.skip(2);
          return seatOutputText(this.firstLive(0, 1) as FusionSeatResult);
        }
      }
      const merge = await this.runSeat(
        2,
        [
          input,
          '',
          'Two seats answered the request above in parallel. Merge their outputs into one answer.',
          describeSeat(first, 'Output of'),
          describeSeat(second, 'Output of'),
        ].join('\n'),
        true,
      );
      if (merge.status === 'ok') return seatOutputText(merge);
      // The merge died: answer with the first live input, reported degraded.
      return seatOutputText(this.firstLive(0, 1) as FusionSeatResult);
    }
    // handoff
    const draft = await this.runSeat(0, input, false);
    if (definition.gate) {
      this.gate = await this.runGate(definition.gate, input, [draft]);
      if (this.gate.status === 'sufficient') {
        this.skip(1);
        return seatOutputText(draft);
      }
    }
    const answer = await this.runSeat(
      1,
      [
        input,
        '',
        'Another seat drafted an answer to the request above. Review the draft and give the final answer.',
        describeSeat(draft, 'Draft from'),
      ].join('\n'),
      true,
    );
    if (answer.status === 'ok') return seatOutputText(answer);
    if (draft.status === 'ok') return seatOutputText(draft);
    return undefined;
  }

  private result(status: InferenceRunStatus, text: string): FusionRunResult {
    for (const seat of this.seats) {
      const usage = this.usage.get(seat.name);
      if (usage) seat.usage = usage;
    }
    return {
      runId: this.runId,
      fusionKey: this.key,
      mode: this.definition.mode,
      status,
      text,
      seats: this.seats.map((seat) => ({ ...seat })),
      ...(this.gate ? { gate: this.gate } : {}),
      durationMs: Math.max(0, this.options.now() - this.started),
    };
  }

  private async record(result: FusionRunResult): Promise<void> {
    if (!this.context.recordRun) return;
    const ran = result.seats.filter(
      (seat) => seat.status === 'ok' || seat.status === 'failed',
    );
    try {
      await this.context.recordRun({
        id: result.runId,
        fusionKey: result.fusionKey,
        mode: result.mode,
        ...(this.entryPromptKey ? { promptKey: this.entryPromptKey } : {}),
        seats: ran.length,
        degradedSeats: ran.filter(isDegraded).length,
        status: result.status,
        duration: result.durationMs,
        // Identities and totals only: never prompts, inputs or outputs.
        details: {
          seats: result.seats.map((seat) => ({
            persona: seat.name,
            prompt: seat.prompt,
            status: seat.status,
            target: seat.target,
            ...(seat.model ? { model: seat.model } : {}),
            ...(seat.usage ? { usage: seat.usage } : {}),
            ...(seat.substitutions
              ? { substitutions: seat.substitutions }
              : {}),
            ...(seat.failure
              ? {
                  failure: {
                    reason: seat.failure.reason,
                    ...(seat.failure.code ? { code: seat.failure.code } : {}),
                  },
                }
              : {}),
            ...(seat.raw !== undefined ? { json: 'unparsed' } : {}),
            ...(seat.json !== undefined ? { json: 'parsed' } : {}),
            ...(seat.durationMs !== undefined
              ? { durationMs: seat.durationMs }
              : {}),
          })),
          ...(result.gate
            ? {
                gate: {
                  status: result.gate.status,
                  ...(result.gate.choice ? { choice: result.gate.choice } : {}),
                  ...(result.gate.confidence !== undefined
                    ? { confidence: result.gate.confidence }
                    : {}),
                  ...(result.gate.model ? { model: result.gate.model } : {}),
                },
              }
            : {}),
        },
      });
    } catch {
      // Recording must never mask the run's own outcome.
    }
  }

  async run(input: string): Promise<FusionRunResult> {
    const stop = this.context.observeUsage?.(this.runId, (event) => {
      const seat = event.tags.seat;
      if (!seat) return;
      const usage = this.usage.get(seat) ?? {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      };
      usage.promptTokens += event.promptTokens;
      usage.completionTokens += event.completionTokens;
      usage.totalTokens += event.totalTokens;
      if (event.estimatedCost !== undefined) {
        usage.estimatedCost = (usage.estimatedCost ?? 0) + event.estimatedCost;
      }
      this.usage.set(seat, usage);
    });
    try {
      let text: string | undefined;
      try {
        text = await this.interpret(input);
      } catch (error) {
        const failed = this.result('failed', '');
        await this.record(failed);
        if (error instanceof InferenceConfigError || isInferenceAbort(error)) {
          throw error;
        }
        throw new InferenceFusionError(failed, error);
      }
      if (text === undefined) {
        const failed = this.result('failed', '');
        await this.record(failed);
        throw new InferenceFusionError(failed);
      }
      const degraded = this.seats.some(isDegraded);
      const done = this.result(degraded ? 'degraded' : 'ok', text);
      await this.record(done);
      return done;
    } finally {
      stop?.();
    }
  }
}

/** A seat that died, or answered through a substitution. */
function isDegraded(seat: FusionSeatResult): boolean {
  return (
    seat.status === 'failed' ||
    (seat.status === 'ok' && (seat.substitutions?.length ?? 0) > 0)
  );
}

/** A fusion a target names, validated. */
interface ResolvedFusion {
  key: string;
  definition: InferenceFusionDefinition;
}

/** Where a fusion definition was found, for validation paths. */
type FusionOrigin = 'resolver' | 'config' | 'registry';

function unknownFusion(
  context: InferenceExecutionContext,
  key: string,
): InferenceConfigError {
  return new InferenceConfigError([
    {
      path: `resolution.${context.resolution.tierResolved}`,
      code: 'fusion-unknown',
      message: `tier "${context.resolution.tierResolved}" names unknown fusion "${key}"`,
    },
  ]);
}

/**
 * Validate a definition before it runs, whatever its origin: structure
 * against the call's config (aliases) and every seat's prompt key. A
 * resolver's stored definition (an app override row, #4800) gets the same
 * checks as config, so an invalid stored row is a load error, never a run.
 */
function validatedFusion(
  context: InferenceExecutionContext,
  key: string,
  definition: InferenceFusionDefinition,
  origin: FusionOrigin,
): ResolvedFusion {
  const path =
    origin === 'config'
      ? `inference.fusions.${key}`
      : origin === 'resolver'
        ? `resolver.fusions.${key}`
        : `fusions.${key}`;
  const issues = [
    ...findFusionDefinitionIssues(definition, path, context.config),
    ...findFusionDefinitionPromptIssues(definition, path),
  ];
  if (issues.length > 0) throw new InferenceConfigError(issues);
  return { key, definition };
}

/**
 * Resolve and validate the fusion a target names without the context's
 * lookup (older cores, direct executor contexts): config, then registry.
 */
function fusionForSync(context: InferenceExecutionContext): ResolvedFusion {
  const key = String(context.resolution.target.fusion ?? '').trim();
  const definition = key ? lookupFusion(key, context.config) : undefined;
  if (!definition) throw unknownFusion(context, key);
  const origin: FusionOrigin = Object.hasOwn(context.config?.fusions ?? {}, key)
    ? 'config'
    : 'registry';
  return validatedFusion(context, key, definition, origin);
}

/**
 * Resolve and validate the fusion a target names (#4800). With core's
 * `context.lookupFusion()`, precedence is: the registered resolver's stored
 * layer (app override rows), then `inference.fusions`, then the
 * `defineFusion()` registry; each source replaces a lower one whole.
 */
async function fusionFor(
  context: InferenceExecutionContext,
): Promise<ResolvedFusion> {
  if (typeof context.lookupFusion !== 'function') return fusionForSync(context);
  const key = String(context.resolution.target.fusion ?? '').trim();
  if (!key) throw unknownFusion(context, key);
  const found = await context.lookupFusion(key);
  if (found) {
    return validatedFusion(context, key, found.definition, found.source);
  }
  const registered = fusionStore().get(key);
  if (!registered) throw unknownFusion(context, key);
  return validatedFusion(context, key, registered, 'registry');
}

/**
 * Run a fusion for one input and return the structured result. Throws
 * {@link InferenceFusionError} (`INFERENCE_FUSION_FAILED`) when every seat
 * died, with the run recorded as `failed`.
 */
export async function runFusion(
  context: InferenceExecutionContext,
  input: string,
  callerOptions: InferenceCallOptions = {},
  options: ChainExecutorOptions = {},
): Promise<FusionRunResult> {
  return runResolvedFusion(
    context,
    await fusionFor(context),
    input,
    callerOptions,
    options,
  );
}

function runResolvedFusion(
  context: InferenceExecutionContext,
  { key, definition }: ResolvedFusion,
  input: string,
  callerOptions: InferenceCallOptions,
  options: ChainExecutorOptions,
): Promise<FusionRunResult> {
  const resolved: Required<ChainExecutorOptions> = {
    retryDelayMs: options.retryDelayMs ?? (() => 200 + Math.random() * 300),
    sleep:
      options.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: options.now ?? (() => Date.now()),
  };
  return new FusionRun(context, key, definition, callerOptions, resolved).run(
    input,
  );
}

function unsupported(method: string): never {
  throw new TypeError(
    `A fusion target runs through message(); ${method}() is not supported (#4753).`,
  );
}

/**
 * The client core receives for a `{ fusion }` target: `message()` runs the
 * fusion and resolves the final seat's text; `onFusionResult` in the call
 * options receives the structured result.
 */
export function createFusionClient(
  context: InferenceExecutionContext,
  options: ChainExecutorOptions = {},
): InferenceModelClient {
  // Without core's lookup the definition is known now: fail at bind time.
  // With it (#4800) the lookup may read stored rows, so it starts now, once
  // per client, and an unknown or invalid fusion fails the first call before
  // any seat runs (nothing is recorded).
  let fusion: Promise<ResolvedFusion>;
  if (typeof context.lookupFusion === 'function') {
    fusion = fusionFor(context);
    fusion.catch(() => {}); // surfaced by message(); never unhandled
  } else {
    fusion = Promise.resolve(fusionForSync(context));
  }
  return {
    async message(text: string, callerOptions?: InferenceCallOptions) {
      const { onFusionResult, ...rest } = (callerOptions ?? {}) as
        | (InferenceCallOptions & FusionCallOptions)
        | Record<string, never>;
      const result = await runResolvedFusion(
        context,
        await fusion,
        text,
        rest,
        options,
      );
      if (typeof onFusionResult === 'function') onFusionResult(result);
      return result.text;
    },
    chat: () => unsupported('chat'),
    complete: () => unsupported('complete'),
    stream: () => unsupported('stream'),
    embed: () => unsupported('embed'),
  };
}

/**
 * The executor registered into core's seam: `alias` / `candidates` chains
 * and `fusion` targets (#4753), one `kinds` table.
 */
export function createChainExecutor(
  options: ChainExecutorOptions = {},
): InferenceExecutor {
  return {
    kinds: EXECUTOR_KINDS,
    createClient: (context) =>
      inferenceTargetKind(context.resolution.target) === 'fusion'
        ? createFusionClient(context, options)
        : createChainClient(context, options),
  };
}

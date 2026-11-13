/**
 * `smrt doctor --ai` (#4752), Node-only subpath.
 *
 * {@link checkInferenceBindings} walks every tier and alias binding offline:
 * provider recognized, key variable present, model named, alias resolvable
 * and cycle-free. With `probe` it also calls each candidate's cheapest
 * list endpoint with a short timeout. Keys are read to test presence and
 * sent only to their own endpoint; they are never printed or returned.
 *
 * The same functions back the settings panel's test-connection action
 * (#4754): `probeInferenceCandidate()` tests one candidate.
 *
 * With `probe`, each candidate also reports its capabilities (#4758) and
 * their source: the model listing's evidence (context length, supported
 * parameters, input modalities) is the `probe` layer under core's preset
 * table and over its model heuristic. The SDK's `getCapabilities()` is the
 * call-time `provider` layer; the doctor builds no SDK clients, so it reads
 * that layer only through `sdkCapabilities`.
 */
import { AI_PROVIDER_TYPES } from '@happyvertical/ai/types';
import {
  getDefaultAIKeyEnvName,
  redactBaseUrl,
} from '@happyvertical/smrt-config';
import {
  assertInferenceConfig,
  getInferenceConfig,
  INFERENCE_PRESET_CAPABILITIES,
  INFERENCE_PRESETS,
  INFERENCE_TIERS,
  type InferenceCandidate,
  type InferenceCapabilities,
  type InferenceCapabilityEvidence,
  type InferenceConfig,
  type InferenceTarget,
  inferenceCapabilitiesFromSdk,
  inferenceCapabilityHeuristic,
  inferencePresetFor,
  inferenceTargetKind,
  isInferencePresetId,
  resolveInferenceCapabilities,
} from '@happyvertical/smrt-core';
import { candidateLabel, findInferenceConfigIssues } from './config.js';
import type { InferenceConfigIssue } from './types.js';

export type InferenceDoctorStatus = 'ok' | 'warn' | 'error';

/** Result of one reachability probe. */
export interface InferenceProbeResult {
  /** True when the endpoint answered and accepted the credential. */
  reachable: boolean;
  /** True when no cheap probe is known for the provider. */
  skipped?: boolean;
  /** HTTP status, when one came back. */
  status?: number;
  durationMs: number;
  /** Short, key-free explanation. */
  detail: string;
  /**
   * What the model listing says about the candidate's model (#4758), when
   * the endpoint answered and listed it with capability fields.
   */
  capabilities?: InferenceCapabilityEvidence;
}

/** One candidate of a binding. */
export interface InferenceDoctorCandidate {
  label: string;
  status: InferenceDoctorStatus;
  problems: string[];
  probe?: InferenceProbeResult;
  /** With `probe`: the candidate's capabilities and their source (#4758). */
  capabilities?: InferenceCapabilities;
}

/** One tier or alias binding. */
export interface InferenceDoctorBinding {
  /** `tier:<name>` or `alias:<name>`. */
  binding: string;
  /** Key-free description of the target. */
  target: string;
  status: InferenceDoctorStatus;
  problems: string[];
  candidates: InferenceDoctorCandidate[];
}

/** The doctor's answer. `ok` is false when any binding cannot resolve. */
export interface InferenceDoctorReport {
  ok: boolean;
  /** False when no `inference` block is configured (every tier uses the configured client). */
  configured: boolean;
  bindings: InferenceDoctorBinding[];
  issues: InferenceConfigIssue[];
}

/** Options for {@link checkInferenceBindings} and the probe. */
export interface CheckInferenceBindingsOptions {
  /** Config to check. Default: core's merged `getInferenceConfig()`. */
  config?: InferenceConfig;
  /** Environment for key presence. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Call each candidate's list endpoint. Default false (offline). */
  probe?: boolean;
  /** Probe timeout per candidate, ms. Default 3000. */
  timeoutMs?: number;
  /** Fetch implementation for probes. Default global `fetch`. */
  fetch?: typeof fetch;
  /** Recognized provider names. Default the AI SDK's provider list. */
  providers?: readonly string[];
  /**
   * The SDK `getCapabilities()` answer for a candidate (the `provider`
   * layer, #4758), when the host can supply one. Default: none; the doctor
   * builds no SDK clients.
   */
  sdkCapabilities?: (
    candidate: InferenceCandidate,
  ) => unknown | Promise<unknown>;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const OPENAI_DEFAULT_BASE = 'https://api.openai.com/v1';
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com/v1';
const GEMINI_DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OLLAMA_DEFAULT_BASE = 'http://127.0.0.1:11434';
const OPENAI_COMPATIBLE = new Set(['openai', 'litellm', 'bifrost']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function worst(statuses: InferenceDoctorStatus[]): InferenceDoctorStatus {
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('warn')) return 'warn';
  return 'ok';
}

/** Where a candidate's key comes from, without reading its value out. */
function keySource(candidate: InferenceCandidate): {
  env?: string;
  inline?: boolean;
  required: boolean;
  providerDefault?: boolean;
} {
  if (text(candidate.apiKey)) return { inline: true, required: true };
  const env = text(candidate.apiKeyEnv);
  if (env) return { env, required: true };
  const preset = text(candidate.preset);
  if (preset && isInferencePresetId(preset)) {
    return { required: INFERENCE_PRESETS[preset].requiresApiKey };
  }
  if (text(candidate.baseUrl)) return { required: false };
  const providerEnv = getDefaultAIKeyEnvName(candidate.provider);
  return providerEnv
    ? { env: providerEnv, required: true, providerDefault: true }
    : { required: false };
}

function resolveKey(
  candidate: InferenceCandidate,
  env: Record<string, string | undefined>,
): string | undefined {
  const source = keySource(candidate);
  if (source.inline) return text(candidate.apiKey);
  return source.env ? text(env[source.env]) : undefined;
}

function checkCandidateOffline(
  candidate: InferenceCandidate,
  options: Required<Pick<CheckInferenceBindingsOptions, 'env' | 'providers'>>,
): InferenceDoctorCandidate {
  const label = candidateLabel(candidate);
  const problems: string[] = [];
  const statuses: InferenceDoctorStatus[] = [];
  const fail = (message: string) => {
    problems.push(message);
    statuses.push('error');
  };
  const preset = text(candidate.preset);
  const provider = text(candidate.provider);
  if (preset) {
    if (!isInferencePresetId(preset)) fail(`unknown preset "${preset}"`);
  } else if (provider) {
    if (!options.providers.includes(provider.toLowerCase())) {
      fail(`provider "${provider}" is not recognized`);
    }
  }
  if (!text(candidate.model)) {
    problems.push('no model named (the provider default answers)');
    statuses.push('warn');
  }
  const source = keySource(candidate);
  if (source.required && !resolveKey(candidate, options.env)) {
    if (source.providerDefault) {
      // Same-provider targets inherit the configured client's key, which
      // this offline check cannot see: a warning, not an error.
      problems.push(
        `key variable ${source.env} is not set (fine if the configured client is this provider)`,
      );
      statuses.push('warn');
    } else {
      fail(
        source.env
          ? `key variable ${source.env} is not set`
          : 'a key is required and none is configured',
      );
    }
  }
  if ((text(candidate.apiKeyEnv) || text(candidate.apiKey)) && !preset) {
    if (!text(candidate.baseUrl)) {
      fail('brings its own key without a baseUrl');
    }
  }
  const sdkWide = ['HAVE_AI_BASE_URL', 'HAVE_AI_API_KEY'].find((name) =>
    text(options.env[name]),
  );
  if (sdkWide && provider && !preset && !text(candidate.baseUrl)) {
    // Core refuses another provider's default endpoint while the SDK-wide
    // fallbacks are set; only the configured provider passes.
    problems.push(
      `${sdkWide} is set: core refuses this candidate unless ${provider} is the configured provider (give it a baseUrl and apiKeyEnv)`,
    );
    statuses.push('warn');
  }
  return { label, status: worst(statuses), problems };
}

function probeRequest(
  candidate: InferenceCandidate,
  key: string | undefined,
): { url: string; headers: Record<string, string> } | undefined {
  const preset = text(candidate.preset);
  const provider = (text(candidate.provider) ?? '').toLowerCase();
  const baseUrl =
    text(candidate.baseUrl) ??
    (preset && isInferencePresetId(preset)
      ? INFERENCE_PRESETS[preset].baseUrl
      : undefined);
  const trim = (url: string) => url.replace(/\/+$/, '');
  // A gateway has no public default endpoint: never send its key to OpenAI's.
  if (
    !preset &&
    !baseUrl &&
    provider !== 'openai' &&
    OPENAI_COMPATIBLE.has(provider)
  ) {
    return undefined;
  }
  if (preset || OPENAI_COMPATIBLE.has(provider)) {
    return {
      url: `${trim(baseUrl ?? OPENAI_DEFAULT_BASE)}/models`,
      headers: key ? { authorization: `Bearer ${key}` } : {},
    };
  }
  if (provider === 'anthropic') {
    return {
      url: `${trim(baseUrl ?? ANTHROPIC_DEFAULT_BASE)}/models`,
      headers: {
        'anthropic-version': '2023-06-01',
        ...(key ? { 'x-api-key': key } : {}),
      },
    };
  }
  if (provider === 'gemini') {
    return {
      url: `${trim(baseUrl ?? GEMINI_DEFAULT_BASE)}/models`,
      headers: key ? { 'x-goog-api-key': key } : {},
    };
  }
  if (provider === 'ollama') {
    return {
      url: `${trim(baseUrl ?? OLLAMA_DEFAULT_BASE)}/api/tags`,
      headers: {},
    };
  }
  return undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Capability evidence for `model` from a list endpoint's body (#4758):
 * OpenAI-compatible `data[]` entries (OpenRouter `context_length`,
 * `supported_parameters`, `architecture.input_modalities`; LM Studio
 * `max_context_length`; llama.cpp `meta.n_ctx_train`) and Gemini
 * `models[].inputTokenLimit`. Unknown shapes give nothing.
 */
export function inferenceCapabilitiesFromModelListing(
  body: unknown,
  model: string | undefined,
): InferenceCapabilityEvidence | undefined {
  if (!model || !body || typeof body !== 'object') return undefined;
  const record = body as { data?: unknown; models?: unknown };
  const list = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  const entry = list.find((item) => {
    const row = item as { id?: unknown; name?: unknown };
    return (
      row?.id === model ||
      row?.name === model ||
      row?.name === `models/${model}`
    );
  }) as Record<string, unknown> | undefined;
  if (!entry) return undefined;
  const out: InferenceCapabilityEvidence = {};
  const meta = entry.meta as Record<string, unknown> | undefined;
  const topProvider = entry.top_provider as Record<string, unknown> | undefined;
  const maxContext =
    positive(entry.context_length) ??
    positive(entry.max_context_length) ??
    positive(topProvider?.context_length) ??
    positive(meta?.n_ctx_train) ??
    positive(entry.inputTokenLimit);
  if (maxContext !== undefined) out.maxContext = maxContext;
  if (Array.isArray(entry.supported_parameters)) {
    const params = entry.supported_parameters;
    out.tools = params.includes('tools');
    out.json =
      params.includes('response_format') ||
      params.includes('structured_outputs');
  }
  const architecture = entry.architecture as
    | Record<string, unknown>
    | undefined;
  if (Array.isArray(architecture?.input_modalities)) {
    out.vision = architecture.input_modalities.includes('image');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A candidate's capabilities from every layer the doctor can see (#4758):
 * the host's SDK answer (when given), the preset table, the probe's
 * evidence, the model heuristic, then assumed.
 */
export async function inferenceCandidateCapabilities(
  candidate: InferenceCandidate,
  options: {
    probe?: InferenceCapabilityEvidence;
    sdkCapabilities?: CheckInferenceBindingsOptions['sdkCapabilities'];
  } = {},
): Promise<InferenceCapabilities> {
  const preset = inferencePresetFor(candidate);
  let sdk: unknown;
  // The SDK answer describes the provider's own endpoint only.
  if (options.sdkCapabilities && !text(candidate.baseUrl) && !preset) {
    try {
      sdk = await options.sdkCapabilities(candidate);
    } catch {
      sdk = undefined;
    }
  }
  return resolveInferenceCapabilities({
    provider: inferenceCapabilitiesFromSdk(sdk),
    preset: preset ? INFERENCE_PRESET_CAPABILITIES[preset] : undefined,
    probe: options.probe,
    heuristic: inferenceCapabilityHeuristic(candidate),
  });
}

/**
 * The URL {@link probeInferenceCandidate} would call for a candidate, or
 * `undefined` when no cheap probe is known. Key-free; the settings key rule
 * (#4754) binds a key to this URL's origin.
 */
export function inferenceProbeUrl(
  candidate: InferenceCandidate,
): string | undefined {
  return probeRequest(candidate, undefined)?.url;
}

/**
 * Probe one candidate's cheapest list endpoint (`/models`, Ollama
 * `/api/tags`) with a short timeout. The key goes only to the candidate's
 * own endpoint and never appears in the result.
 */
export async function probeInferenceCandidate(
  candidate: InferenceCandidate,
  options: Pick<
    CheckInferenceBindingsOptions,
    'env' | 'timeoutMs' | 'fetch'
  > = {},
): Promise<InferenceProbeResult> {
  const env = options.env ?? process.env;
  const preset = text(candidate.preset);
  if (preset && !isInferencePresetId(preset)) {
    return {
      reachable: false,
      durationMs: 0,
      detail: `not probed: unknown preset "${preset}"`,
    };
  }
  if (
    (text(candidate.apiKey) || text(candidate.apiKeyEnv)) &&
    !text(candidate.baseUrl) &&
    !preset
  ) {
    // Core's pair rule: a candidate's own key travels only with its own
    // endpoint. Refuse before any request rather than sending it to a
    // provider default.
    return {
      reachable: false,
      durationMs: 0,
      detail:
        'not probed: a candidate key needs its own baseUrl (it is never sent to a provider default endpoint)',
    };
  }
  const request = probeRequest(candidate, resolveKey(candidate, env));
  if (!request) {
    return {
      reachable: false,
      skipped: true,
      durationMs: 0,
      detail: `no cheap probe for provider "${candidate.provider ?? 'default'}"`,
    };
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const where = redactBaseUrl(request.url) ?? 'endpoint';
  try {
    const response = await doFetch(request.url, {
      method: 'GET',
      headers: request.headers,
      signal: controller.signal,
      // A redirect would carry the key's header to another host.
      redirect: 'manual',
    });
    const durationMs = Date.now() - started;
    if (
      response.type === 'opaqueredirect' ||
      (response.status >= 300 && response.status < 400)
    ) {
      return {
        reachable: false,
        status: response.status || undefined,
        durationMs,
        detail: `${where} redirected (not followed: the key stays with its own endpoint)`,
      };
    }
    if (response.ok) {
      let capabilities: InferenceCapabilityEvidence | undefined;
      try {
        capabilities = inferenceCapabilitiesFromModelListing(
          await response.json(),
          text(candidate.model),
        );
      } catch {
        // A listing that is not JSON still proves reachability.
      }
      return {
        reachable: true,
        status: response.status,
        durationMs,
        detail: `${where} answered ${response.status}`,
        ...(capabilities ? { capabilities } : {}),
      };
    }
    const why =
      response.status === 401 || response.status === 403
        ? 'credential rejected'
        : response.status === 402 || response.status === 429
          ? 'quota or rate limit'
          : 'endpoint error';
    return {
      reachable: false,
      status: response.status,
      durationMs,
      detail: `${where} answered ${response.status} (${why})`,
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    return {
      reachable: false,
      durationMs: Date.now() - started,
      detail: aborted
        ? `${where} did not answer within ${timeoutMs} ms`
        : `${where} unreachable (${error instanceof Error ? error.name : 'error'})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function describeTarget(target: InferenceTarget): string {
  const kind = inferenceTargetKind(target);
  if (kind === 'alias') return `alias ${String(target.alias)}`;
  if (kind === 'candidates') {
    return `${target.candidates?.length ?? 0} inline candidate(s)`;
  }
  if (kind === 'fusion') return `fusion ${String(target.fusion)}`;
  if (kind !== 'single') return `kind ${kind} (not checked here)`;
  const base = text(target.baseUrl);
  return `${candidateLabel(target)}${base ? ` at ${redactBaseUrl(base)}` : ''}`;
}

/**
 * Walk every tier and alias binding; see the module comment. Never throws on
 * a bad config: problems come back in the report, and `ok` is false when any
 * binding cannot resolve.
 */
export async function checkInferenceBindings(
  options: CheckInferenceBindingsOptions = {},
): Promise<InferenceDoctorReport> {
  const env = options.env ?? process.env;
  const providers = (options.providers ?? AI_PROVIDER_TYPES).map((name) =>
    name.toLowerCase(),
  );
  const bindings: InferenceDoctorBinding[] = [];
  let config: InferenceConfig | undefined;
  try {
    config = 'config' in options ? options.config : getInferenceConfig();
    assertInferenceConfig(config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const issue: InferenceConfigIssue = {
      path: 'inference',
      code: 'candidate-invalid',
      message,
    };
    return {
      ok: false,
      configured: true,
      bindings: [
        {
          binding: 'inference',
          target: 'config',
          status: 'error',
          problems: [message],
          candidates: [],
        },
      ],
      issues: [issue],
    };
  }
  const issues = findInferenceConfigIssues(config);
  const aliases = config?.aliases ?? {};
  const issuesFor = (prefix: string) =>
    issues
      .filter(
        (issue) =>
          issue.path === prefix ||
          issue.path.startsWith(`${prefix}.`) ||
          issue.path.startsWith(`${prefix}[`),
      )
      .map((issue) => issue.message);

  const checkList = async (
    list: readonly InferenceCandidate[],
  ): Promise<InferenceDoctorCandidate[]> => {
    const out: InferenceDoctorCandidate[] = [];
    for (const candidate of list) {
      const nested = text(candidate.alias);
      if (nested) {
        out.push({
          label: `alias:${nested}`,
          status: Object.hasOwn(aliases, nested) ? 'ok' : 'error',
          problems: Object.hasOwn(aliases, nested)
            ? [`expands alias ${nested} (checked under alias:${nested})`]
            : [`unknown alias "${nested}"`],
        });
        continue;
      }
      const checked = checkCandidateOffline(candidate, { env, providers });
      if (options.probe && checked.status !== 'error') {
        checked.probe = await probeInferenceCandidate(candidate, {
          env,
          timeoutMs: options.timeoutMs,
          fetch: options.fetch,
        });
        if (!checked.probe.reachable && !checked.probe.skipped) {
          checked.status = 'error';
          checked.problems.push(checked.probe.detail);
        }
        checked.capabilities = await inferenceCandidateCapabilities(candidate, {
          probe: checked.probe.capabilities,
          sdkCapabilities: options.sdkCapabilities,
        });
      }
      out.push(checked);
    }
    return out;
  };

  const settle = (
    binding: string,
    target: string,
    configProblems: string[],
    candidates: InferenceDoctorCandidate[],
  ): InferenceDoctorBinding => {
    const usable = candidates.some((candidate) => candidate.status !== 'error');
    const status: InferenceDoctorStatus =
      configProblems.length > 0 || (candidates.length > 0 && !usable)
        ? 'error'
        : candidates.every((candidate) => candidate.status === 'ok')
          ? 'ok'
          : // Some candidate cannot answer but another can: the chain still
            // resolves, so this warns rather than fails.
            'warn';
    return {
      binding,
      target,
      status,
      problems: [
        ...configProblems,
        ...(configProblems.length === 0 && candidates.length > 0 && !usable
          ? ['no candidate can answer']
          : []),
      ],
      candidates,
    };
  };

  for (const tier of INFERENCE_TIERS) {
    const target = config?.tiers?.[tier];
    const name = `tier:${tier}`;
    if (!target || Object.keys(target).length === 0) {
      bindings.push({
        binding: name,
        target: 'the configured client',
        status: 'ok',
        problems: [],
        candidates: [],
      });
      continue;
    }
    const kind = inferenceTargetKind(target);
    const configProblems = issuesFor(`inference.tiers.${tier}`);
    let candidates: InferenceDoctorCandidate[] = [];
    if (kind === 'single') {
      candidates = await checkList([target as InferenceCandidate]);
    } else if (kind === 'candidates') {
      candidates = await checkList(target.candidates ?? []);
    } else if (kind === 'alias') {
      const aliasName = text(target.alias);
      candidates = [
        {
          label: `alias:${aliasName ?? '?'}`,
          status:
            aliasName && Object.hasOwn(aliases, aliasName) ? 'ok' : 'error',
          problems: [],
        },
      ];
    }
    bindings.push(
      settle(name, describeTarget(target), configProblems, candidates),
    );
  }

  for (const [name, alias] of Object.entries(aliases)) {
    const list = Array.isArray(alias?.candidates) ? alias.candidates : [];
    bindings.push(
      settle(
        `alias:${name}`,
        `${list.length} candidate(s)${alias?.description ? ` — ${alias.description}` : ''}`,
        issuesFor(`inference.aliases.${name}`),
        await checkList(list),
      ),
    );
  }

  // Fusions (#4753): structure only; each seat's target is a tier, alias or
  // model checked above. Prompt keys are the app's and are checked at load.
  for (const [name, fusion] of Object.entries(config?.fusions ?? {})) {
    const seats = Array.isArray(fusion?.seats) ? fusion.seats.length : 0;
    bindings.push(
      settle(
        `fusion:${name}`,
        `${String(fusion?.mode)}, ${seats} seat(s)${fusion?.description ? ` — ${fusion.description}` : ''}`,
        issuesFor(`inference.fusions.${name}`),
        [],
      ),
    );
  }

  // A tier bound to an alias inherits that alias's verdict.
  for (const binding of bindings) {
    if (!binding.binding.startsWith('tier:')) continue;
    const ref = binding.candidates[0]?.label;
    if (binding.candidates.length !== 1 || !ref?.startsWith('alias:')) continue;
    const resolved = bindings.find((entry) => entry.binding === ref);
    const reference = binding.candidates[0];
    if (resolved && reference) reference.status = resolved.status;
    if (resolved?.status === 'error') {
      binding.status = 'error';
      binding.problems.push(`${ref} cannot resolve`);
    } else if (resolved?.status === 'warn' && binding.status === 'ok') {
      binding.status = 'warn';
      binding.problems.push(`${ref} has a candidate that cannot answer`);
    }
  }

  return {
    ok: !bindings.some((binding) => binding.status === 'error'),
    configured: !!config && (!!config.tiers || !!config.aliases),
    bindings,
    issues,
  };
}

/** One line describing capabilities, e.g. `json no, tools yes, … (preset)`. */
export function formatInferenceCapabilities(
  capabilities: InferenceCapabilities,
): string {
  const flag = (value: boolean) => (value ? 'yes' : 'no');
  return `json ${flag(capabilities.json)}, tools ${flag(capabilities.tools)}, vision ${flag(capabilities.vision)}, context ${capabilities.maxContext ?? 'unknown'} (source: ${capabilities.source})`;
}

const ICON: Record<InferenceDoctorStatus, string> = {
  ok: '✅',
  warn: '⚠️ ',
  error: '❌',
};

/** The lines `smrt doctor --ai` prints for a report. */
export function formatInferenceDoctorReport(
  report: InferenceDoctorReport,
): string[] {
  const lines: string[] = [];
  if (!report.configured) {
    lines.push(
      '  No inference config: every tier uses the configured AI client.',
    );
  }
  for (const binding of report.bindings) {
    lines.push(
      `  ${ICON[binding.status]} ${binding.binding} → ${binding.target}`,
    );
    for (const problem of binding.problems) lines.push(`       ${problem}`);
    for (const candidate of binding.candidates) {
      const probe = candidate.probe
        ? candidate.probe.skipped
          ? ' (probe skipped)'
          : ` (${candidate.probe.detail}, ${candidate.probe.durationMs} ms)`
        : '';
      lines.push(`     ${ICON[candidate.status]} ${candidate.label}${probe}`);
      if (candidate.capabilities) {
        lines.push(
          `         capabilities: ${formatInferenceCapabilities(candidate.capabilities)}`,
        );
      }
      for (const problem of candidate.problems) {
        if (candidate.probe && problem === candidate.probe.detail) continue;
        lines.push(`         ${problem}`);
      }
    }
  }
  return lines;
}

export * from './hosted.js';
export type { InferenceConfigIssue } from './types.js';

/**
 * Capability detection for inference targets (#4758).
 *
 * Small local models (WebLLM, llama.cpp builds of 1–3B models) often have no
 * JSON response format, no tool calling and a small context. Core consults
 * the target's capabilities before it chooses a request shape, so `is()` can
 * fall back to a text verdict, `do()` can refuse or drop tools, and an
 * oversized prompt is truncated instead of sent to fail.
 *
 * Resolution order is a contract, per field, highest first:
 *
 * 1. `provider`: the AI SDK client's `getCapabilities()`, trusted only on the
 *    provider's own endpoint. On a custom `baseUrl` (presets, local servers)
 *    the SDK reports its vendor's static table, not the server's, so it is
 *    not an answer.
 * 2. `preset`: {@link INFERENCE_PRESET_CAPABILITIES}, matched by the
 *    target's preset id or its preset `baseUrl` (#4674).
 * 3. `probe`: evidence from the doctor's model listing (`smrt doctor --ai
 *    --probe`); never read at call time.
 * 4. `heuristic`: {@link INFERENCE_CAPABILITY_HEURISTICS}, a model-name table
 *    for known local families.
 * 5. `assumed`: everything enabled, no context limit: today's behavior.
 *
 * A field takes the first layer that states it; `source` names the highest
 * layer that stated any field, and is `assumed` when none did, which leaves
 * a call exactly as it was before #4758.
 *
 * Browser-safe: imports nothing from `@happyvertical/ai`.
 */

import {
  INFERENCE_PRESETS,
  type InferencePresetId,
  isInferencePresetId,
} from './inference-presets.js';

/** Where an {@link InferenceCapabilities} answer came from. */
export const INFERENCE_CAPABILITY_SOURCES = [
  'provider',
  'preset',
  'probe',
  'assumed',
] as const;

/** One of {@link INFERENCE_CAPABILITY_SOURCES}. */
export type InferenceCapabilitySource =
  (typeof INFERENCE_CAPABILITY_SOURCES)[number];

/** What a resolved target can do. */
export interface InferenceCapabilities {
  /** Accepts `responseFormat: { type: 'json_object' }`. */
  json: boolean;
  /** Accepts `tools` (function calling). */
  tools: boolean;
  /** Accepts image input. */
  vision: boolean;
  /** Context window in tokens, when known. */
  maxContext?: number;
  /**
   * The highest layer that stated a field. A model-name heuristic reports
   * `assumed`: it is a guess, not an answer.
   */
  source: InferenceCapabilitySource;
}

/** Capability fields one layer states; absent fields fall through. */
export type InferenceCapabilityEvidence = Partial<
  Omit<InferenceCapabilities, 'source'>
>;

/** The layers {@link resolveInferenceCapabilities} reads, highest first. */
export interface InferenceCapabilityLayers {
  provider?: InferenceCapabilityEvidence;
  preset?: InferenceCapabilityEvidence;
  probe?: InferenceCapabilityEvidence;
  heuristic?: InferenceCapabilityEvidence;
}

/** Everything enabled, no context limit: the behavior before #4758. */
export const ASSUMED_INFERENCE_CAPABILITIES: Readonly<InferenceCapabilities> =
  Object.freeze({ json: true, tools: true, vision: true, source: 'assumed' });

/**
 * What each preset's server is known to accept. Only fields a server
 * decides for every model it serves belong here; model-dependent fields
 * (tools, vision, context) fall through to the model heuristic.
 *
 * - `lm-studio` rejects `response_format: json_object` (it takes
 *   `json_schema` only), so JSON mode is off.
 * - `llama.cpp`'s server enforces `json_object` with a grammar.
 * - `lemonade` and `openrouter` vary by model: no entry.
 */
export const INFERENCE_PRESET_CAPABILITIES: Readonly<
  Partial<Record<InferencePresetId, InferenceCapabilityEvidence>>
> = Object.freeze({
  'lm-studio': { json: false },
  'llama.cpp': { json: true },
});

/** One row of {@link INFERENCE_CAPABILITY_HEURISTICS}. */
export interface InferenceCapabilityHeuristic {
  /** Matches the lower-cased provider name, when set. */
  provider?: string;
  /** Matches the model name, when set. */
  model?: RegExp;
  capabilities: InferenceCapabilityEvidence;
}

/**
 * Model-name heuristics for known local families, first match wins. Rows
 * only turn features off (or name a context): an unknown model stays
 * `assumed`.
 */
export const INFERENCE_CAPABILITY_HEURISTICS: readonly InferenceCapabilityHeuristic[] =
  Object.freeze([
    // WebLLM runs MLC builds in the browser: text in, text out.
    {
      provider: 'webllm',
      capabilities: { json: false, tools: false, vision: false },
    },
    {
      model: /-mlc$/i,
      capabilities: { json: false, tools: false, vision: false },
    },
    // Small chat models with no reliable JSON or tool use.
    {
      model: /tinyllama/i,
      capabilities: {
        json: false,
        tools: false,
        vision: false,
        maxContext: 2048,
      },
    },
    {
      model: /smollm|(^|[/:_-])phi-?2([/:_.-]|$)|(^|[/:_-])gpt-?2([/:_.-]|$)/i,
      capabilities: { json: false, tools: false, vision: false },
    },
    {
      model: /qwen2(\.5)?[-:_]0\.5b|llama-?3\.2[-:_]1b|gemma-?2[-:_]2b/i,
      capabilities: { json: false, tools: false, vision: false },
    },
  ]);

const FIELDS = ['json', 'tools', 'vision', 'maxContext'] as const;

function hasEvidence(layer: InferenceCapabilityEvidence | undefined): boolean {
  return !!layer && FIELDS.some((field) => layer[field] !== undefined);
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function clean(
  layer: InferenceCapabilityEvidence | undefined,
): InferenceCapabilityEvidence | undefined {
  if (!layer) return undefined;
  const out: InferenceCapabilityEvidence = {};
  for (const field of ['json', 'tools', 'vision'] as const) {
    if (typeof layer[field] === 'boolean') out[field] = layer[field];
  }
  const maxContext = positiveInt(layer.maxContext);
  if (maxContext !== undefined) out.maxContext = maxContext;
  return out;
}

/**
 * Merge the layers in contract order (see the module comment). Pure: the
 * same layers always give the same answer.
 */
export function resolveInferenceCapabilities(
  layers: InferenceCapabilityLayers = {},
): InferenceCapabilities {
  const ordered: Array<
    [InferenceCapabilitySource, InferenceCapabilityEvidence | undefined]
  > = [
    ['provider', clean(layers.provider)],
    ['preset', clean(layers.preset)],
    ['probe', clean(layers.probe)],
    // A heuristic is a guess: it may switch features off, but it is never
    // reported as an answer.
    ['assumed', clean(layers.heuristic)],
  ];
  const result: InferenceCapabilities = { ...ASSUMED_INFERENCE_CAPABILITIES };
  let source: InferenceCapabilitySource | undefined;
  for (const field of FIELDS) {
    for (const [, layer] of ordered) {
      const value = layer?.[field];
      if (value === undefined) continue;
      (result as unknown as Record<string, unknown>)[field] = value;
      break;
    }
  }
  for (const [layerSource, layer] of ordered) {
    if (hasEvidence(layer)) {
      source = layerSource;
      break;
    }
  }
  result.source = source ?? 'assumed';
  return result;
}

/**
 * Evidence from an AI SDK `getCapabilities()` answer. `functions` →
 * `tools`, `vision`, `maxContextLength` (when positive) → `maxContext`.
 * The SDK has no JSON-mode flag today: `json` is read from a boolean
 * `json` / `jsonMode` field or a `json` / `json_object` entry in
 * `supportedOperations` when a provider adds one, else left to lower layers.
 */
export function inferenceCapabilitiesFromSdk(
  answer: unknown,
): InferenceCapabilityEvidence | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const caps = answer as Record<string, unknown>;
  const out: InferenceCapabilityEvidence = {};
  if (typeof caps.functions === 'boolean') out.tools = caps.functions;
  if (typeof caps.vision === 'boolean') out.vision = caps.vision;
  const maxContext = positiveInt(caps.maxContextLength);
  if (maxContext !== undefined) out.maxContext = maxContext;
  if (typeof caps.json === 'boolean') out.json = caps.json;
  else if (typeof caps.jsonMode === 'boolean') out.json = caps.jsonMode;
  else if (
    Array.isArray(caps.supportedOperations) &&
    caps.supportedOperations.some(
      (operation) => operation === 'json' || operation === 'json_object',
    )
  ) {
    out.json = true;
  }
  return hasEvidence(out) ? out : undefined;
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** The preset a target names, or whose endpoint it uses. */
export function inferencePresetFor(target: {
  preset?: unknown;
  baseUrl?: unknown;
}): InferencePresetId | undefined {
  if (isInferencePresetId(target.preset)) return target.preset;
  if (typeof target.baseUrl !== 'string' || target.baseUrl.trim() === '') {
    return undefined;
  }
  const url = normalizeUrl(target.baseUrl);
  for (const [id, preset] of Object.entries(INFERENCE_PRESETS)) {
    if (normalizeUrl(preset.baseUrl) === url) return id as InferencePresetId;
  }
  return undefined;
}

/** The first {@link INFERENCE_CAPABILITY_HEURISTICS} row that matches. */
export function inferenceCapabilityHeuristic(target: {
  provider?: unknown;
  model?: unknown;
}): InferenceCapabilityEvidence | undefined {
  const provider =
    typeof target.provider === 'string' ? target.provider.toLowerCase() : '';
  const model = typeof target.model === 'string' ? target.model.trim() : '';
  for (const row of INFERENCE_CAPABILITY_HEURISTICS) {
    if (row.provider !== undefined && row.provider !== provider) continue;
    if (row.model !== undefined && !row.model.test(model)) continue;
    if (row.provider === undefined && row.model === undefined) continue;
    return { ...row.capabilities };
  }
  return undefined;
}

/** A target's identity as capability detection reads it. */
export interface InferenceCapabilityTarget {
  provider?: string;
  model?: string;
  baseUrl?: string;
  preset?: string;
}

/**
 * Capabilities for a bound target, from every layer but the probe. `sdk` is
 * the client's `getCapabilities()` answer (omit it when there is none); it
 * counts only when the target has no custom `baseUrl` (see the module
 * comment).
 */
export function detectInferenceCapabilities(
  target: InferenceCapabilityTarget,
  sdk?: unknown,
): InferenceCapabilities {
  const customEndpoint =
    typeof target.baseUrl === 'string' && target.baseUrl.trim() !== '';
  const preset = inferencePresetFor(target);
  return resolveInferenceCapabilities({
    provider: customEndpoint ? undefined : inferenceCapabilitiesFromSdk(sdk),
    preset: preset ? INFERENCE_PRESET_CAPABILITIES[preset] : undefined,
    heuristic: inferenceCapabilityHeuristic(target),
  });
}

/** True when `value` is an {@link InferenceCapabilities} object. */
export function isInferenceCapabilities(
  value: unknown,
): value is InferenceCapabilities {
  if (!value || typeof value !== 'object') return false;
  const caps = value as Record<string, unknown>;
  return (
    typeof caps.json === 'boolean' &&
    typeof caps.tools === 'boolean' &&
    typeof caps.vision === 'boolean' &&
    (INFERENCE_CAPABILITY_SOURCES as readonly unknown[]).includes(caps.source)
  );
}

/**
 * A conservative token estimate for a prompt: three characters per token,
 * rounded up. Local tokenizers average 3.5–4 characters per token on prose
 * and fewer on JSON, so this errs toward truncating early.
 */
export function estimateInferenceTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/**
 * Parse a yes/no verdict from a model that answered in text (#4758): the
 * `is()` / `evaluate()` path for targets without JSON mode. Accepts, in
 * order, a JSON `{ "result": boolean }` (or a bare boolean), a leading
 * `yes`/`true` or `no`/`false` word (the convention smrt-analytics'
 * legacy route already relies on, `/^\s*(yes|true)\b/i`), then a
 * `{ "result": … }` object embedded in prose. Returns `undefined` when none
 * matches; callers raise their usual "unexpected answer" error.
 */
export function parseInferenceTextVerdict(text: string): boolean | undefined {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') return undefined;
  const fromJson = (candidate: string): boolean | undefined => {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === 'boolean') return parsed;
      const result = (parsed as { result?: unknown } | null)?.result;
      return typeof result === 'boolean' ? result : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = fromJson(trimmed);
  if (direct !== undefined) return direct;
  const lead = trimmed.replace(/^[\s"'`*_>#.:-]+/, '');
  if (/^(yes|true)\b/i.test(lead)) return true;
  if (/^(no|false)\b/i.test(lead)) return false;
  const embedded = trimmed.match(/\{[^{}]*\}/);
  return embedded ? fromJson(embedded[0]) : undefined;
}

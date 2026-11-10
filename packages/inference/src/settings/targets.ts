/**
 * The vocabulary of stored inference bindings (#4754): binding ids, the
 * target shapes a settings write may store, the allow-list references a
 * tenant write is checked against, and key-free labels.
 *
 * Pure and browser-safe: no `node:`, no SDK, no smrt-config.
 */
import {
  assertInferenceTranscriptsConfig,
  INFERENCE_TIERS,
  type InferenceAlias,
  type InferenceCandidate,
  type InferenceTarget,
  type InferenceTier,
  inferenceTargetKind,
  isInferenceTier,
} from '@happyvertical/smrt-core';

/** How a user or app gets inference. Stored as a user choice, never a binding. */
export const INFERENCE_MODES = ['byo', 'local', 'hosted', 'off'] as const;
export type InferenceMode = (typeof INFERENCE_MODES)[number];

/** Binding id of `auto`'s default tier. */
export const DEFAULT_TIER_BINDING = 'default-tier';

/**
 * Binding id of the app's transcript setting (#4781). App scope only:
 * tenants cannot override transcripts (owner decision 2026-11-08).
 */
export const TRANSCRIPTS_BINDING = 'transcripts';

/** A binding id stored in `_smrt_inference_overrides.binding`. */
export type InferenceBindingId =
  | `tier:${InferenceTier}`
  | typeof DEFAULT_TIER_BINDING
  | typeof TRANSCRIPTS_BINDING
  | `alias:${string}`
  | `fusion:${string}`;

/** `inference.aliases` / fusion names: what a binding id may carry after its prefix. */
export const INFERENCE_BINDING_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type InferenceBindingKind =
  | 'tier'
  | 'default-tier'
  | 'transcripts'
  | 'alias'
  | 'fusion';

/** A parsed binding id. */
export interface ParsedInferenceBinding {
  kind: InferenceBindingKind;
  /** The tier, alias or fusion name (absent for `default-tier`). */
  name?: string;
}

/** Thrown for a malformed binding id or an invalid stored value. Nothing is written. */
export class InferenceBindingValueError extends Error {
  readonly status = 400;
  constructor(
    readonly binding: string,
    reason: string,
  ) {
    super(`Invalid inference binding "${binding}": ${reason}`);
    this.name = 'InferenceBindingValueError';
  }
}

/** Parse a binding id, or `null` when it is not one this package stores. */
export function parseInferenceBinding(
  binding: unknown,
): ParsedInferenceBinding | null {
  if (typeof binding !== 'string') return null;
  if (binding === DEFAULT_TIER_BINDING) return { kind: 'default-tier' };
  if (binding === TRANSCRIPTS_BINDING) return { kind: 'transcripts' };
  const match = /^(tier|alias|fusion):(.+)$/.exec(binding);
  if (!match) return null;
  const [, kind, name] = match as unknown as [string, string, string];
  if (kind === 'tier') {
    return isInferenceTier(name) ? { kind: 'tier', name } : null;
  }
  if (!INFERENCE_BINDING_NAME_PATTERN.test(name)) return null;
  return { kind: kind as 'alias' | 'fusion', name };
}

/** The binding id of one tier. */
export function tierBinding(tier: InferenceTier): `tier:${InferenceTier}` {
  return `tier:${tier}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/**
 * Key-shaped members are never stored in a binding row: keys live only in
 * smrt-secrets, written by the host (#4754 storage split). `apiKeyEnv` (the
 * name of a variable) is allowed, and so is `key`: #4753 fusion
 * definitions carry one as their identifier.
 */
const KEY_MEMBERS = new Set([
  'apikey',
  'api_key',
  'apikeys',
  'secret',
  'token',
  'password',
  'authorization',
  'bearer',
]);

/**
 * A deep copy of `value` with every credential-shaped member removed. Used
 * on every config-backed value a settings screen receives: config tiers and
 * alias candidates may legitimately carry a literal `apiKey` (resolvers and
 * endpoint-bound config), and none of it may reach a browser.
 */
export function stripKeyMembers<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripKeyMembers) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [member, inner] of Object.entries(value)) {
    if (KEY_MEMBERS.has(member.toLowerCase())) continue;
    out[member] = stripKeyMembers(inner);
  }
  return out as T;
}

/** Dotted path of the first key-shaped member anywhere in `value`, or `null`. */
export function findKeyMember(value: unknown, path = ''): string | null {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findKeyMember(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const [member, inner] of Object.entries(value)) {
    const here = path ? `${path}.${member}` : member;
    if (KEY_MEMBERS.has(member.toLowerCase())) return here;
    const found = findKeyMember(inner, here);
    if (found) return found;
  }
  return null;
}

/**
 * The tier target a settings write may store. A tier binds exactly one of:
 *
 * - a model: `{ provider?, model }` (no `baseUrl`: an endpoint needs its own
 *   key, and keys are never stored here; bind an alias whose candidate names
 *   `baseUrl` + `apiKeyEnv` or a preset instead);
 * - an alias: `{ alias }`;
 * - a fusion (#4753): `{ kind: 'fusion', fusion }`.
 *
 * `null` means "same as default" (inherit the lower layer).
 */
export function normalizeTierTarget(
  binding: string,
  value: unknown,
): InferenceTarget | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new InferenceBindingValueError(binding, 'a tier target is an object');
  }
  const keyMember = findKeyMember(value);
  if (keyMember) {
    throw new InferenceBindingValueError(
      binding,
      `"${keyMember}" looks like a credential; keys are stored only through smrt-secrets`,
    );
  }
  const fusion = text(value.fusion);
  const alias = text(value.alias);
  const model = text(value.model);
  const provider = text(value.provider);
  const kind = value.kind;
  const allowed = new Set(['kind', 'fusion', 'alias', 'model', 'provider']);
  const extra = Object.keys(value).filter((member) => !allowed.has(member));
  if (extra.length > 0) {
    throw new InferenceBindingValueError(
      binding,
      `unsupported member(s) ${extra.join(', ')} (endpoints and inline candidates belong in an alias)`,
    );
  }
  const shapes = [fusion, alias, model].filter(Boolean).length;
  if (shapes !== 1) {
    throw new InferenceBindingValueError(
      binding,
      'a tier target is exactly one of { model, provider? }, { alias } or { kind: "fusion", fusion }',
    );
  }
  if (fusion) {
    if (kind !== undefined && kind !== 'fusion') {
      throw new InferenceBindingValueError(binding, 'fusion kind mismatch');
    }
    if (!INFERENCE_BINDING_NAME_PATTERN.test(fusion)) {
      throw new InferenceBindingValueError(binding, 'invalid fusion name');
    }
    return { kind: 'fusion', fusion } as unknown as InferenceTarget;
  }
  if (alias) {
    if (kind !== undefined && kind !== 'alias') {
      throw new InferenceBindingValueError(binding, 'alias kind mismatch');
    }
    if (!INFERENCE_BINDING_NAME_PATTERN.test(alias)) {
      throw new InferenceBindingValueError(binding, 'invalid alias name');
    }
    return { alias };
  }
  if (kind !== undefined && kind !== 'single') {
    throw new InferenceBindingValueError(binding, 'model kind mismatch');
  }
  return provider ? { provider, model } : { model };
}

/**
 * An alias definition a settings write may store: `{ candidates, description? }`,
 * every candidate exactly one of provider/model, preset/model or alias, and
 * never a literal key (`apiKeyEnv` names a variable and needs `baseUrl`).
 * Structural checks only; cross-references are checked against the layered
 * config by the settings service.
 */
export function normalizeAliasDefinition(
  binding: string,
  value: unknown,
): InferenceAlias | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || !Array.isArray(value.candidates)) {
    throw new InferenceBindingValueError(
      binding,
      'an alias is { candidates: [...], description? }',
    );
  }
  const keyMember = findKeyMember(value);
  if (keyMember) {
    throw new InferenceBindingValueError(
      binding,
      `"${keyMember}" looks like a credential; keys are stored only through smrt-secrets`,
    );
  }
  if (value.candidates.length === 0) {
    throw new InferenceBindingValueError(binding, 'an alias needs candidates');
  }
  const allowed = new Set([
    'provider',
    'model',
    'baseUrl',
    'apiKeyEnv',
    'preset',
    'alias',
    'params',
  ]);
  const candidates: InferenceCandidate[] = value.candidates.map(
    (candidate: unknown, index: number) => {
      if (!isRecord(candidate)) {
        throw new InferenceBindingValueError(
          binding,
          `candidates[${index}] must be an object`,
        );
      }
      const extra = Object.keys(candidate).filter(
        (member) => !allowed.has(member),
      );
      if (extra.length > 0) {
        throw new InferenceBindingValueError(
          binding,
          `candidates[${index}] has unsupported member(s) ${extra.join(', ')}`,
        );
      }
      const out: InferenceCandidate = {};
      for (const member of allowed) {
        if (member === 'params') continue;
        const inner = text(candidate[member]);
        if (inner) (out as Record<string, string>)[member] = inner;
      }
      if (candidate.params !== undefined) {
        if (!isRecord(candidate.params)) {
          throw new InferenceBindingValueError(
            binding,
            `candidates[${index}].params must be an object`,
          );
        }
        out.params = { ...candidate.params };
      }
      return out;
    },
  );
  const description = text(value.description);
  return description ? { candidates, description } : { candidates };
}

/**
 * A fusion config entry (#4753) a settings write may store: a JSON object
 * with no credential members. Its meaning belongs to the fusion interpreter;
 * this package only stores it (app scope only).
 */
export function normalizeFusionDefinition(
  binding: string,
  value: unknown,
): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new InferenceBindingValueError(binding, 'a fusion is a JSON object');
  }
  const keyMember = findKeyMember(value);
  if (keyMember) {
    throw new InferenceBindingValueError(
      binding,
      `"${keyMember}" looks like a credential; keys are stored only through smrt-secrets`,
    );
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

/** `default-tier` stores `{ tier }`. */
export function normalizeDefaultTier(
  binding: string,
  value: unknown,
): InferenceTier | null {
  if (value === null || value === undefined) return null;
  const tier = isRecord(value) ? value.tier : value;
  if (!isInferenceTier(tier)) {
    throw new InferenceBindingValueError(
      binding,
      `the default tier must be one of ${INFERENCE_TIERS.join(', ')}`,
    );
  }
  return tier;
}

/** The stored transcript setting (#4781): core's app settings layer. */
export interface InferenceTranscriptSettingsValue {
  enabled?: boolean;
  /** Success capture rate, 0..1. */
  sample?: number;
  /** Per-row byte cap. */
  maxBytes?: number;
}

const TRANSCRIPT_SETTING_MEMBERS = new Set(['enabled', 'sample', 'maxBytes']);

/**
 * `transcripts` stores `{ enabled?, sample?, maxBytes? }`, validated by
 * core's `assertInferenceTranscriptsConfig()`. Per-prompt sampling stays in
 * config; any other member is refused.
 */
export function normalizeTranscriptSettings(
  binding: string,
  value: unknown,
): InferenceTranscriptSettingsValue | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) {
    throw new InferenceBindingValueError(
      binding,
      'the transcript setting must be an object',
    );
  }
  const extra = Object.keys(value).filter(
    (member) => !TRANSCRIPT_SETTING_MEMBERS.has(member),
  );
  if (extra.length > 0) {
    throw new InferenceBindingValueError(
      binding,
      `the transcript setting carries enabled, sample and maxBytes only (got ${extra.join(', ')})`,
    );
  }
  try {
    assertInferenceTranscriptsConfig(value);
  } catch (error) {
    throw new InferenceBindingValueError(
      binding,
      error instanceof Error ? error.message : String(error),
    );
  }
  const out: InferenceTranscriptSettingsValue = {};
  if (value.enabled !== undefined) out.enabled = value.enabled as boolean;
  if (value.sample !== undefined) out.sample = value.sample as number;
  if (value.maxBytes !== undefined) out.maxBytes = value.maxBytes as number;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The allow-list reference of a tier target: `model:<provider>/<model>`
 * (`model:default/<model>` without a provider), `alias:<name>` or
 * `fusion:<name>`; for the default tier, `tier:<name>`. Key-free.
 */
export function inferenceTargetRef(target: InferenceTarget): string {
  const kind = inferenceTargetKind(target);
  const record = target as InferenceTarget & { fusion?: string };
  if (kind === 'fusion') return `fusion:${record.fusion ?? ''}`;
  if (kind === 'alias') return `alias:${target.alias ?? ''}`;
  if (kind === 'candidates') return 'candidates';
  return `model:${target.provider ?? 'default'}/${target.model ?? 'default'}`;
}

/**
 * Whether `ref` matches one allow-list pattern. A pattern is an exact
 * reference, a prefix ending in `*` (`model:openai/*`, `alias:*`), or `*`.
 */
export function matchesAllowPattern(ref: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return ref.startsWith(pattern.slice(0, -1));
  return ref === pattern;
}

/**
 * The tenant allow-list check: a tenant may bind only a reference the app
 * row's list matches. No list (or an empty one) allows nothing, so a tenant
 * cannot bind a tier the operator has not opened.
 */
export function isAllowedByList(
  ref: string,
  allowList: readonly string[] | null | undefined,
): boolean {
  return (allowList ?? []).some((pattern) => matchesAllowPattern(ref, pattern));
}

/** Validate and normalize an allow-list (patterns are short, key-free references). */
export function normalizeAllowList(
  binding: string,
  value: unknown,
): string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new InferenceBindingValueError(
      binding,
      'an allow-list is an array of references',
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== 'string' ||
      !/^(\*|(model|alias|fusion|tier):[A-Za-z0-9._/:*-]{1,160})$/.test(entry)
    ) {
      throw new InferenceBindingValueError(
        binding,
        `invalid allow-list entry ${JSON.stringify(entry)}`,
      );
    }
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

/** Key-free description of a tier target for screens and reports. */
export function describeInferenceTarget(
  target: InferenceTarget | null | undefined,
): string {
  if (!target || Object.keys(target).length === 0) {
    return 'Same as default (configured client)';
  }
  const kind = inferenceTargetKind(target);
  const record = target as InferenceTarget & { fusion?: string };
  if (kind === 'fusion') return `Fusion ${record.fusion ?? '?'}`;
  if (kind === 'alias') return `Alias ${target.alias ?? '?'}`;
  if (kind === 'candidates') {
    return `${target.candidates?.length ?? 0} inline candidate(s)`;
  }
  return `${target.provider ?? 'default'}/${target.model ?? 'default model'}`;
}

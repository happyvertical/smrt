/**
 * Alias config validation and chain expansion (#4752). Browser-safe: reads
 * the environment through `globalThis.process` when one exists.
 */
import {
  INFERENCE_PRESETS,
  INFERENCE_TIERS,
  type InferenceAlias,
  type InferenceCandidate,
  type InferenceConfig,
  type InferenceTarget,
  type InferenceTier,
  inferenceTargetKind,
  isInferencePresetId,
} from '@happyvertical/smrt-core';
import { InferenceConfigError } from './errors.js';
import type { InferenceConfigIssue, InferenceFailureClass } from './types.js';

/** Target kinds this package runs. */
export const CHAIN_KINDS = ['alias', 'candidates'] as const;

/** Placeholder key for keyless endpoints, matching core's presets. */
const KEYLESS_PLACEHOLDER = 'smrt-local';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

/** True when the config binds any chain (aliases or a chain tier target). */
export function hasInferenceChains(config: InferenceConfig | undefined) {
  if (!config) return false;
  if (isRecord(config.aliases) && Object.keys(config.aliases).length > 0) {
    return true;
  }
  return Object.values(config.tiers ?? {}).some((target) =>
    (CHAIN_KINDS as readonly string[]).includes(
      inferenceTargetKind(target as InferenceTarget),
    ),
  );
}

function checkCandidate(
  candidate: unknown,
  path: string,
  aliases: Record<string, unknown>,
  issues: InferenceConfigIssue[],
): void {
  if (!isRecord(candidate)) {
    issues.push({
      path,
      code: 'candidate-invalid',
      message: `${path} must be an object`,
    });
    return;
  }
  const alias = text(candidate.alias);
  if (candidate.alias !== undefined) {
    if (!alias) {
      issues.push({
        path,
        code: 'candidate-invalid',
        message: `${path}.alias must be a non-empty string`,
      });
    } else if (!Object.hasOwn(aliases, alias)) {
      issues.push({
        path,
        code: 'alias-unknown',
        message: `${path} references unknown alias "${alias}"`,
      });
    }
    const extra = ['provider', 'model', 'preset', 'baseUrl', 'apiKeyEnv'].find(
      (key) => candidate[key] !== undefined,
    );
    if (extra) {
      issues.push({
        path,
        code: 'candidate-invalid',
        message: `${path} names an alias and "${extra}"; an alias candidate takes nothing else`,
      });
    }
    return;
  }
  const preset = text(candidate.preset);
  if (candidate.preset !== undefined) {
    if (!preset || !isInferencePresetId(preset)) {
      issues.push({
        path,
        code: 'preset-unknown',
        message: `${path} names unknown preset "${String(candidate.preset)}"; expected one of ${Object.keys(INFERENCE_PRESETS).join(', ')}`,
      });
    }
    if (!text(candidate.model)) {
      issues.push({
        path,
        code: 'candidate-invalid',
        message: `${path} names preset "${String(candidate.preset)}" without a model`,
      });
    }
    if (candidate.provider !== undefined) {
      issues.push({
        path,
        code: 'candidate-invalid',
        message: `${path} names both a preset and a provider`,
      });
    }
    return;
  }
  if (!text(candidate.provider) && !text(candidate.model)) {
    issues.push({
      path,
      code: 'candidate-invalid',
      message: `${path} needs an alias, a preset, or a provider and model`,
    });
    return;
  }
  if (
    (text(candidate.apiKeyEnv) || text(candidate.apiKey)) &&
    !text(candidate.baseUrl)
  ) {
    issues.push({
      path,
      code: 'candidate-key-without-endpoint',
      message: `${path} brings its own key without a baseUrl; a key travels only with its own endpoint (name the provider's baseUrl, or drop apiKeyEnv to use the provider's own key variable)`,
    });
  }
}

function checkCandidateList(
  list: unknown,
  path: string,
  aliases: Record<string, unknown>,
  issues: InferenceConfigIssue[],
): void {
  if (!Array.isArray(list) || list.length === 0) {
    issues.push({
      path,
      code: 'alias-empty',
      message: `${path} has no candidates`,
    });
    return;
  }
  list.forEach((candidate, index) => {
    checkCandidate(candidate, `${path}[${index}]`, aliases, issues);
  });
}

/** Alias names a chain references directly (its `alias` candidates). */
function aliasEdges(alias: unknown): string[] {
  if (!isRecord(alias) || !Array.isArray(alias.candidates)) return [];
  return alias.candidates
    .map((candidate) =>
      isRecord(candidate) ? text(candidate.alias) : undefined,
    )
    .filter((name): name is string => !!name);
}

/**
 * Every problem in an `inference` block's chains: an alias with no
 * candidates, a reference to an unknown alias, an alias cycle, a malformed
 * candidate. Each issue names its offender by config path.
 */
export function findInferenceConfigIssues(
  config: InferenceConfig | undefined,
): InferenceConfigIssue[] {
  const issues: InferenceConfigIssue[] = [];
  if (!config) return issues;
  const aliases: Record<string, unknown> = isRecord(config.aliases)
    ? config.aliases
    : {};

  for (const [name, alias] of Object.entries(aliases)) {
    const path = `inference.aliases.${name}`;
    if (!isRecord(alias)) {
      issues.push({
        path,
        code: 'alias-empty',
        message: `${path} must be an object with candidates`,
      });
      continue;
    }
    checkCandidateList(alias.candidates, `${path}.candidates`, aliases, issues);
  }

  for (const tier of INFERENCE_TIERS) {
    const target = config.tiers?.[tier];
    if (!target) continue;
    const path = `inference.tiers.${tier}`;
    const kind = inferenceTargetKind(target);
    if (kind === 'alias') {
      const name = text(target.alias);
      if (!name) {
        issues.push({
          path,
          code: 'candidate-invalid',
          message: `${path} has kind "alias" without an alias name`,
        });
      } else if (!Object.hasOwn(aliases, name)) {
        issues.push({
          path,
          code: 'alias-unknown',
          message: `${path} points at unknown alias "${name}"`,
        });
      }
    } else if (kind === 'candidates') {
      checkCandidateList(
        target.candidates,
        `${path}.candidates`,
        aliases,
        issues,
      );
    }
  }

  // Cycles: depth-first over alias → alias edges, reported once each.
  const state = new Map<string, 'visiting' | 'done'>();
  const reported = new Set<string>();
  const visit = (name: string, stack: string[]) => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      const cycle = [...stack.slice(stack.indexOf(name)), name];
      const key = [...cycle.slice(0, -1)].sort().join('|');
      if (!reported.has(key)) {
        reported.add(key);
        issues.push({
          path: `inference.aliases.${name}`,
          code: 'alias-cycle',
          message: `inference.aliases has a cycle: ${cycle.join(' -> ')}`,
        });
      }
      return;
    }
    state.set(name, 'visiting');
    for (const next of aliasEdges(aliases[name])) {
      if (Object.hasOwn(aliases, next)) visit(next, [...stack, name]);
    }
    state.set(name, 'done');
  };
  for (const name of Object.keys(aliases)) visit(name, []);

  return issues;
}

/** Throw an {@link InferenceConfigError} naming every offender. */
export function validateInferenceConfig(
  config: InferenceConfig | undefined,
): void {
  const issues = findInferenceConfigIssues(config);
  if (issues.length > 0) throw new InferenceConfigError(issues);
}

/** One expanded chain entry, ready to bind. */
export interface ChainStep {
  /** The tier whose chain this step belongs to. */
  tier: InferenceTier;
  /** Stable, key-free label used in substitution records. */
  label: string;
  /** A `single` target for core's `clientFor()`. */
  target: InferenceTarget;
  /** Per-call defaults for this candidate. */
  params?: Record<string, unknown>;
  /** Dedupe key: provider, model, endpoint and credential source. */
  identity: string;
  /** Set when the step cannot run (missing key); it is skipped, recorded. */
  unavailable?: InferenceFailureClass;
  /** The alias the step came from, if any. */
  alias?: string;
}

function readEnv(name: string): string | undefined {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  return text(env?.[name]);
}

/** Label for a candidate: `provider/model`, `preset:<id>/model`, `default`. */
export function candidateLabel(candidate: InferenceCandidate): string {
  const model = text(candidate.model);
  const preset = text(candidate.preset);
  if (preset) return `preset:${preset}/${model ?? 'default'}`;
  const provider = text(candidate.provider);
  if (!provider && !model) return 'default';
  return `${provider ?? 'default'}/${model ?? 'default'}`;
}

/**
 * Bind one candidate to a `single` target. Keys come from `apiKey` or the
 * variable named by `apiKeyEnv` at call time; a named variable that is unset
 * makes the step `unavailable: 'credential'` (skipped and recorded, never
 * sent keyless to a key-requiring endpoint).
 */
export function candidateToStep(
  candidate: InferenceCandidate,
  tier: InferenceTier,
  alias?: string,
): ChainStep {
  const label = candidateLabel(candidate);
  const model = text(candidate.model);
  const params = isRecord(candidate.params) ? candidate.params : undefined;
  const keyEnv = text(candidate.apiKeyEnv);
  const key = text(candidate.apiKey) ?? (keyEnv ? readEnv(keyEnv) : undefined);
  const missingKey = !!keyEnv && !key && !text(candidate.apiKey);
  const preset = text(candidate.preset);
  let target: InferenceTarget;
  if (preset && isInferencePresetId(preset)) {
    const definition = INFERENCE_PRESETS[preset];
    target = {
      provider: 'openai',
      baseUrl: text(candidate.baseUrl) ?? definition.baseUrl,
      ...(model ? { model } : {}),
      apiKey: key ?? KEYLESS_PLACEHOLDER,
    };
    const presetNeedsKey = definition.requiresApiKey && !key;
    return {
      tier,
      label,
      target,
      ...(params ? { params } : {}),
      identity: JSON.stringify([
        'preset',
        preset,
        model,
        target.baseUrl,
        keyEnv,
      ]),
      ...(missingKey || presetNeedsKey
        ? { unavailable: 'credential' as const }
        : {}),
      ...(alias ? { alias } : {}),
    };
  }
  const provider = text(candidate.provider);
  const baseUrl = text(candidate.baseUrl);
  target = {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(baseUrl ? { baseUrl, apiKey: key ?? KEYLESS_PLACEHOLDER } : {}),
  };
  return {
    tier,
    label,
    target,
    ...(params ? { params } : {}),
    identity: JSON.stringify([provider, model, baseUrl, keyEnv]),
    ...(missingKey ? { unavailable: 'credential' as const } : {}),
    ...(alias ? { alias } : {}),
  };
}

function expandCandidates(
  candidates: readonly InferenceCandidate[],
  tier: InferenceTier,
  aliases: Record<string, InferenceAlias>,
  owner: string | undefined,
  visiting: Set<string>,
  out: ChainStep[],
): void {
  for (const candidate of candidates) {
    const nested = text(candidate.alias);
    if (nested) expandAlias(nested, tier, aliases, visiting, out);
    else out.push(candidateToStep(candidate, tier, owner));
  }
}

function expandAlias(
  name: string,
  tier: InferenceTier,
  aliases: Record<string, InferenceAlias>,
  visiting: Set<string>,
  out: ChainStep[],
): void {
  if (visiting.has(name)) {
    throw new InferenceConfigError([
      {
        path: `inference.aliases.${name}`,
        code: 'alias-cycle',
        message: `inference.aliases has a cycle through "${name}"`,
      },
    ]);
  }
  const alias = aliases[name];
  if (!alias || !Array.isArray(alias.candidates)) {
    throw new InferenceConfigError([
      {
        path: `inference.aliases.${name}`,
        code: 'alias-unknown',
        message: `unknown alias "${name}"`,
      },
    ]);
  }
  visiting.add(name);
  expandCandidates(alias.candidates, tier, aliases, name, visiting, out);
  visiting.delete(name);
}

/**
 * Expand a tier's target into ordered steps. A `single` target is one step
 * (an empty one is the configured client, labelled `default`); unknown
 * kinds expand to nothing (another executor's).
 */
export function expandTarget(
  target: InferenceTarget,
  tier: InferenceTier,
  config: InferenceConfig | undefined,
): ChainStep[] {
  const aliases = (config?.aliases ?? {}) as Record<string, InferenceAlias>;
  const kind = inferenceTargetKind(target);
  const out: ChainStep[] = [];
  if (kind === 'alias') {
    expandAlias(String(target.alias ?? ''), tier, aliases, new Set(), out);
  } else if (kind === 'candidates') {
    expandCandidates(
      target.candidates ?? [],
      tier,
      aliases,
      undefined,
      new Set(),
      out,
    );
  } else if (kind === 'single') {
    const { kind: _kind, latency: _latency, params, ...single } = target;
    const provider = text(single.provider);
    const model = text(single.model);
    out.push({
      tier,
      label: candidateLabel({ provider, model }),
      target: { ...single },
      ...(isRecord(params) ? { params } : {}),
      identity: JSON.stringify([
        provider,
        model,
        text(single.baseUrl),
        // Per-call only, never logged: two inline keys are two routes.
        text(single.apiKey),
      ]),
    });
  }
  return out;
}

/**
 * Alias config validation and chain expansion (#4752). Browser-safe: reads
 * the environment through `globalThis.process` when one exists.
 */
import {
  INFERENCE_FUSION_MODES,
  INFERENCE_PRESETS,
  INFERENCE_TIERS,
  type InferenceAlias,
  type InferenceCandidate,
  type InferenceConfig,
  type InferenceTarget,
  type InferenceTier,
  inferenceTargetKind,
  isInferencePresetId,
  isInferenceTierRequest,
} from '@happyvertical/smrt-core';
import { InferenceConfigError } from './errors.js';
import { isPromptRegistered, lookupFusion } from './fusion-store.js';
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

/** Target kinds the executor runs: the chains plus `fusion` (#4753). */
export const EXECUTOR_KINDS = [...CHAIN_KINDS, 'fusion'] as const;

/**
 * True when the config binds anything this package validates: aliases,
 * fusions, or a chain or fusion tier target.
 */
export function hasInferenceChains(config: InferenceConfig | undefined) {
  if (!config) return false;
  if (isRecord(config.aliases) && Object.keys(config.aliases).length > 0) {
    return true;
  }
  if (isRecord(config.fusions) && Object.keys(config.fusions).length > 0) {
    return true;
  }
  return Object.values(config.tiers ?? {}).some((target) =>
    (EXECUTOR_KINDS as readonly string[]).includes(
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

function checkTarget(
  target: InferenceTarget,
  path: string,
  aliases: Record<string, unknown>,
  issues: InferenceConfigIssue[],
  config?: InferenceConfig,
): void {
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
  } else if (kind === 'fusion') {
    const name = text(target.fusion);
    if (!name) {
      issues.push({
        path,
        code: 'fusion-invalid',
        message: `${path} has kind "fusion" without a fusion key`,
      });
    } else if (!lookupFusion(name, config)) {
      issues.push({
        path,
        code: 'fusion-unknown',
        message: `${path} points at unknown fusion "${name}" (define it with defineFusion() or inference.fusions)`,
      });
    }
  }
}

/** Seats per mode: each mode's call count is fixed (#4753). */
export const FUSION_SEAT_COUNTS = {
  single: 1,
  pair: 3,
  handoff: 2,
} as const;

/** The gate's other choice label: run the remaining stage. */
export const FUSION_GATE_CONTINUE = 'continue';

/** The `seat` tag of the gate's decision usage row; no seat may use it. */
export const FUSION_GATE_SEAT = 'gate';

/**
 * Structural problems of one fusion definition, named by path (`path` is
 * `inference.fusions.<key>` or `fusions.<key>` for `defineFusion()`).
 * Prompt registration is checked separately ({@link findFusionPromptIssues})
 * because the doctor runs without the app's prompts loaded.
 */
export function findFusionDefinitionIssues(
  definition: unknown,
  path: string,
  config: InferenceConfig | undefined,
): InferenceConfigIssue[] {
  const issues: InferenceConfigIssue[] = [];
  const invalid = (at: string, message: string) =>
    issues.push({ path: at, code: 'fusion-invalid', message });
  if (!isRecord(definition)) {
    invalid(path, `${path} must be an object with mode and seats`);
    return issues;
  }
  const mode = definition.mode;
  const known = (INFERENCE_FUSION_MODES as readonly unknown[]).includes(mode);
  if (!known) {
    invalid(
      `${path}.mode`,
      `${path}.mode must be one of ${INFERENCE_FUSION_MODES.join(', ')}; got "${String(mode)}"`,
    );
  }
  if (
    definition.description !== undefined &&
    typeof definition.description !== 'string'
  ) {
    invalid(`${path}.description`, `${path}.description must be a string`);
  }
  const seats = definition.seats;
  if (!Array.isArray(seats)) {
    invalid(`${path}.seats`, `${path}.seats must be an array of seats`);
  } else {
    const expected = known
      ? FUSION_SEAT_COUNTS[mode as keyof typeof FUSION_SEAT_COUNTS]
      : undefined;
    if (expected !== undefined && seats.length !== expected) {
      invalid(
        `${path}.seats`,
        `${path}.seats must hold exactly ${expected} seat(s) for mode "${String(mode)}"; got ${seats.length}`,
      );
    }
    const aliases: Record<string, unknown> = isRecord(config?.aliases)
      ? config.aliases
      : {};
    const names = new Map<string, number>();
    seats.forEach((seat, index) => {
      const at = `${path}.seats[${index}]`;
      if (!isRecord(seat)) {
        invalid(at, `${at} must be an object with prompt and target`);
        return;
      }
      const prompt = text(seat.prompt);
      if (!prompt) {
        invalid(
          `${at}.prompt`,
          `${at}.prompt must name a registered prompt key`,
        );
      }
      if (seat.name !== undefined && !text(seat.name)) {
        invalid(`${at}.name`, `${at}.name must be a non-empty string`);
      }
      const name = text(seat.name) ?? prompt;
      if (name) {
        const first = names.get(name);
        if (name === FUSION_GATE_SEAT) {
          invalid(
            `${at}.name`,
            `${at}.name "${FUSION_GATE_SEAT}" is reserved for the decision gate's usage row`,
          );
        } else if (first !== undefined) {
          invalid(
            `${at}.name`,
            `${at} has the same name "${name}" as seats[${first}]; name each seat (the name defaults to the prompt key)`,
          );
        } else {
          names.set(name, index);
        }
      }
      if (
        seat.temperature !== undefined &&
        (typeof seat.temperature !== 'number' ||
          !Number.isFinite(seat.temperature))
      ) {
        invalid(`${at}.temperature`, `${at}.temperature must be a number`);
      }
      if (
        seat.output !== undefined &&
        seat.output !== 'text' &&
        seat.output !== 'json'
      ) {
        invalid(`${at}.output`, `${at}.output must be "text" or "json"`);
      }
      const target = seat.target;
      if (typeof target === 'string') {
        if (!isInferenceTierRequest(target)) {
          invalid(
            `${at}.target`,
            `${at}.target "${target}" is not a tier (auto, ${INFERENCE_TIERS.join(', ')})`,
          );
        }
      } else if (isRecord(target)) {
        if (inferenceTargetKind(target as InferenceTarget) === 'fusion') {
          issues.push({
            path: `${at}.target`,
            code: 'fusion-nested',
            message: `${at}.target names another fusion; seats run a tier, an alias or a model, never a fusion`,
          });
        } else {
          checkTarget(
            target as InferenceTarget,
            `${at}.target`,
            aliases,
            issues,
            config,
          );
        }
      } else {
        invalid(
          `${at}.target`,
          `${at}.target must be a tier name or a target ({ alias }, { candidates } or { provider, model })`,
        );
      }
    });
  }
  const gate = definition.gate;
  if (gate !== undefined) {
    if (mode !== 'pair' && mode !== 'handoff') {
      invalid(`${path}.gate`, `${path}.gate applies to pair and handoff only`);
    } else if (!isRecord(gate)) {
      invalid(`${path}.gate`, `${path}.gate must be an object`);
    } else {
      if (!text(gate.criteria)) {
        invalid(
          `${path}.gate.criteria`,
          `${path}.gate.criteria must be a non-empty string`,
        );
      }
      const when = gate.sufficientWhen;
      if (!isRecord(when)) {
        invalid(
          `${path}.gate.sufficientWhen`,
          `${path}.gate.sufficientWhen must be { choice, minConfidence }`,
        );
      } else {
        const choice = text(when.choice);
        if (!choice || choice === FUSION_GATE_CONTINUE) {
          invalid(
            `${path}.gate.sufficientWhen.choice`,
            `${path}.gate.sufficientWhen.choice must be a non-empty label other than "${FUSION_GATE_CONTINUE}"`,
          );
        }
        const min = when.minConfidence;
        if (
          typeof min !== 'number' ||
          !Number.isFinite(min) ||
          min < 0 ||
          min > 1
        ) {
          invalid(
            `${path}.gate.sufficientWhen.minConfidence`,
            `${path}.gate.sufficientWhen.minConfidence must be a number in [0, 1]`,
          );
        }
      }
    }
  }
  return issues;
}

/** Seats of `definition` whose prompt key no `definePrompt()` registered. */
export function findFusionDefinitionPromptIssues(
  definition: unknown,
  path: string,
): InferenceConfigIssue[] {
  if (!isRecord(definition) || !Array.isArray(definition.seats)) return [];
  const issues: InferenceConfigIssue[] = [];
  definition.seats.forEach((seat, index) => {
    const prompt = isRecord(seat) ? text(seat.prompt) : undefined;
    if (prompt && !isPromptRegistered(prompt)) {
      const at = `${path}.seats[${index}].prompt`;
      issues.push({
        path: at,
        code: 'fusion-prompt-unknown',
        message: `${at} names prompt "${prompt}", which no definePrompt() registered`,
      });
    }
  });
  return issues;
}

/**
 * Seats of `inference.fusions` whose prompt key is not registered. A load
 * error: the validating resolver and the executor refuse such a config.
 */
export function findFusionPromptIssues(
  config: InferenceConfig | undefined,
): InferenceConfigIssue[] {
  if (!isRecord(config?.fusions)) return [];
  return Object.entries(config.fusions).flatMap(([key, definition]) =>
    findFusionDefinitionPromptIssues(definition, `inference.fusions.${key}`),
  );
}

/**
 * Validate one resolved target against the config's aliases. A resolver
 * (#4666 per-user bindings) can return chains that never appear in config,
 * so the executor checks every target it runs, not only the config block.
 */
export function validateInferenceTarget(
  target: InferenceTarget,
  path: string,
  config: InferenceConfig | undefined,
): void {
  const issues: InferenceConfigIssue[] = [];
  const aliases: Record<string, unknown> = isRecord(config?.aliases)
    ? config.aliases
    : {};
  checkTarget(target, path, aliases, issues, config);
  if (issues.length > 0) throw new InferenceConfigError(issues);
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
    checkTarget(target, `inference.tiers.${tier}`, aliases, issues, config);
  }

  if (config.fusions !== undefined && !isRecord(config.fusions)) {
    issues.push({
      path: 'inference.fusions',
      code: 'fusion-invalid',
      message: 'inference.fusions must be an object of named fusions',
    });
  } else {
    for (const [key, definition] of Object.entries(config.fusions ?? {})) {
      issues.push(
        ...findFusionDefinitionIssues(
          definition,
          `inference.fusions.${key}`,
          config,
        ),
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

/**
 * Throw an {@link InferenceConfigError} naming every offender, including
 * fusion seats whose prompt key is not registered (a load error).
 */
export function validateInferenceConfig(
  config: InferenceConfig | undefined,
): void {
  const issues = [
    ...findInferenceConfigIssues(config),
    ...findFusionPromptIssues(config),
  ];
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
      // Call-local only, never logged: two keys are two routes.
      identity: JSON.stringify(['preset', preset, model, target.baseUrl, key]),
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
    ...(baseUrl ? { baseUrl } : {}),
    // A key is never dropped: without its own baseUrl, core's pair rule
    // refuses the target rather than running it on the configured key.
    ...(key ? { apiKey: key } : baseUrl ? { apiKey: KEYLESS_PLACEHOLDER } : {}),
  };
  return {
    tier,
    label,
    target,
    ...(params ? { params } : {}),
    // Call-local only, never logged: two keys are two routes.
    identity: JSON.stringify([provider, model, baseUrl, key ?? keyEnv]),
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
  // A chain stamped with a binding origin as a whole (a resolver's hosted
  // chain, #4760) hands it to every candidate step that names none, so core
  // gates each hosted attempt in `clientFor()` and its usage meters as
  // hosted, on a ladder step too.
  const source = target.source;
  if (kind !== 'single' && source !== undefined) {
    for (const step of out) {
      if (step.target.source === undefined) {
        step.target = { ...step.target, source };
      }
    }
  }
  return out;
}

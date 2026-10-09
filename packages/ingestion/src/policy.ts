/** Trusted application policy; source content and model output never supply layers. */
export interface IntakePolicyLayer {
  version: string;
  enabled?: boolean;
  handlers?: string[];
  operations?: string[];
  reviewers?: string[];
  providers?: string[];
  access?: string[];
  requireReview?: boolean;
  maxAttempts?: number;
  maxSteps?: number;
  maxBytes?: number;
  approvalMs?: number;
  leaseMs?: number;
  retentionMs?: number;
  minimumCertainty?: number;
  automation?: {
    handlers: string[];
    evaluationVersion: string;
    consequential?: boolean;
  };
}
export interface IntakePolicy {
  versions: string[];
  enabled: boolean;
  handlers: string[];
  operations: string[];
  reviewers: string[];
  providers: string[];
  access: string[];
  requireReview: boolean;
  maxAttempts: number;
  maxSteps: number;
  maxBytes: number;
  approvalMs: number;
  leaseMs: number;
  retentionMs: number;
  minimumCertainty: number;
  automaticHandlers: string[];
  consequentialAutomation: boolean;
}
const lists = [
  'handlers',
  'operations',
  'reviewers',
  'providers',
  'access',
] as const;
const limits = [
  'maxAttempts',
  'maxSteps',
  'maxBytes',
  'approvalMs',
  'leaseMs',
  'retentionMs',
] as const;
export function intersect(
  left: readonly string[],
  right: readonly string[],
): string[] {
  return [...new Set(left.filter((entry) => right.includes(entry)))].sort();
}
/** First layer is the immutable app ceiling; subsequent layers only narrow. */
export function resolveIntakePolicy(
  layers: readonly IntakePolicyLayer[],
): IntakePolicy {
  if (layers.length < 3 || layers.length > 4)
    throw new Error('Application, tenant and source policy required');
  const app = layers[0];
  const result: IntakePolicy = {
    versions: [],
    enabled: true,
    handlers: [],
    operations: [],
    reviewers: [],
    providers: [],
    access: [],
    requireReview: false,
    maxAttempts: 1,
    maxSteps: 10,
    maxBytes: 65536,
    approvalMs: 300000,
    leaseMs: 30000,
    retentionMs: 86400000,
    minimumCertainty: 1,
    automaticHandlers: [],
    consequentialAutomation: false,
  };
  for (const key of lists) result[key] = [...(app[key] ?? [])];
  for (const key of limits) result[key] = app[key] ?? result[key];
  result.minimumCertainty = app.minimumCertainty ?? 1;
  result.automaticHandlers = [...(app.automation?.handlers ?? [])];
  result.consequentialAutomation = app.automation?.consequential === true;
  for (const [index, layer] of layers.entries()) {
    if (!layer.version || typeof layer.version !== 'string')
      throw new Error('Unknown policy version');
    result.versions.push(layer.version);
    result.enabled &&= layer.enabled !== false;
    result.requireReview ||= layer.requireReview === true;
    for (const key of lists) {
      const values = layer[key];
      if (values !== undefined) {
        if (
          !Array.isArray(values) ||
          values.some((v) => typeof v !== 'string' || !v)
        )
          throw new Error('Invalid policy allowlist');
        result[key] = intersect(result[key], values);
      }
    }
    for (const key of limits) {
      const value = layer[key];
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value <= 0)
          throw new Error('Invalid policy budget');
        result[key] = Math.min(result[key], value);
      }
    }
    if (layer.minimumCertainty !== undefined) {
      if (
        !Number.isFinite(layer.minimumCertainty) ||
        layer.minimumCertainty < 0 ||
        layer.minimumCertainty > 1
      )
        throw new Error('Invalid certainty');
      result.minimumCertainty = Math.max(
        result.minimumCertainty,
        layer.minimumCertainty,
      );
    }
    if (index < 3 || layer.automation !== undefined) {
      if (!layer.automation?.evaluationVersion) result.automaticHandlers = [];
      else
        result.automaticHandlers = intersect(
          result.automaticHandlers,
          layer.automation.handlers,
        );
      result.consequentialAutomation &&=
        layer.automation?.consequential === true;
    }
  }
  if (result.requireReview) result.automaticHandlers = [];
  return result;
}

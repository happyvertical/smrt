/**
 * Self-host rendering of the compose deployment contract: turn a resolved
 * declaration into values for the `smrt-app` chart.
 *
 * The declaration says what the application is. Everything the chart needs
 * beyond that is environment-owned and comes in as explicit inputs: release
 * identity, Secret references, resources, the maintenance responder and the
 * ingress class. Nothing here invents a default for those.
 */

import type {
  ComposeDeploymentDeclaration,
  ComposeDeploymentWorkload,
} from './compose-contract.js';

/** The migration guard capability the chart requires a release to declare. */
export const SMRT_RELEASE_GUARD = 'smrt-release-v1';

const CHART_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const DIGEST_IMAGE = /^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/;

export interface SmrtAppChartSecretRef {
  secretName: string;
  secretKey: string;
}

export interface SmrtAppChartSecretEnv extends SmrtAppChartSecretRef {
  /** Environment variable name. */
  name: string;
  /** Limit the variable to these workloads. Defaults to every workload. */
  services?: string[];
}

export interface SmrtAppChartResources {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

/** Chart roles a contract `worker` may be rendered as. */
export type SmrtAppChartWorkerRole = 'background' | 'task' | 'schedule';

export interface SmrtAppChartWorkloadInputs {
  /**
   * Chart role for a contract `worker`. Defaults to `background`, the
   * singleton runner. Ignored for the web service.
   */
  role?: SmrtAppChartWorkerRole;
  replicas?: number;
  /** Whether the workload writes to the database. Defaults to `true`. */
  writer?: boolean;
  resources?: SmrtAppChartResources;
  terminationGracePeriodSeconds?: number;
}

export interface SmrtAppChartInputs {
  release: {
    id: string;
    phase: 'maintenance' | 'stopped' | 'migrate' | 'verify' | 'active';
    sequence: number;
    attempt: number;
  };
  app: {
    /** Defaults to the Compose file's top-level `name:`. */
    name?: string;
    environment: string;
  };
  /**
   * Image digests of the release that is running now, by service name. Leave
   * it out for a first install: the chart then renders `current: false`.
   */
  currentImages?: Record<string, string>;
  bindings: {
    /** Required when the declaration has a `postgres` binding. */
    postgres?: {
      /** Secret key holding the runtime `DATABASE_URL`. */
      runtime: SmrtAppChartSecretRef;
      /** Secret key holding the migration-only `DATABASE_URL`. */
      migration: SmrtAppChartSecretRef;
    };
    /** Required when the declaration has a `bucket` binding. */
    bucket?: SmrtAppChartSecretRef;
  };
  /** Further runtime settings, each read from a named Secret key. */
  env?: SmrtAppChartSecretEnv[];
  defaults: {
    resources: SmrtAppChartResources;
    terminationGracePeriodSeconds: number;
    replicas?: number;
  };
  /** Per-service overrides, keyed by Compose service name. */
  workloads?: Record<string, SmrtAppChartWorkloadInputs>;
  migration?: {
    resources?: SmrtAppChartResources;
    terminationGracePeriodSeconds?: number;
  };
  /** Passed through as the chart's `maintenance` block. */
  maintenance: Record<string, unknown>;
  /** Passed through as the chart's `ingress` block. `host` defaults to the declared domain. */
  ingress: { className: string; host?: string } & Record<string, unknown>;
}

/** Thrown when a declaration cannot be rendered with the inputs given. */
export class SmrtAppChartValuesError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Cannot render smrt-app chart values:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
    this.name = 'SmrtAppChartValuesError';
    this.problems = problems;
  }
}

/** Own keys only: a Compose service may be called `constructor` or `toString`. */
function own<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The inputs normally come from a hand-written JSON file. Name what is
 * missing instead of failing on a property of `undefined`.
 */
function missingInputs(inputs: unknown): string[] {
  if (!isObject(inputs)) return ['inputs'];
  const missing: string[] = [];
  const requireObject = (field: string): Record<string, unknown> => {
    const value = inputs[field];
    if (isObject(value)) return value;
    missing.push(field);
    return {};
  };
  requireObject('release');
  const app = requireObject('app');
  if (isObject(inputs.app) && typeof app.environment !== 'string') {
    missing.push('app.environment');
  }
  requireObject('bindings');
  const defaults = requireObject('defaults');
  if (isObject(inputs.defaults)) {
    if (!isObject(defaults.resources)) missing.push('defaults.resources');
    if (typeof defaults.terminationGracePeriodSeconds !== 'number') {
      missing.push('defaults.terminationGracePeriodSeconds');
    }
  }
  requireObject('maintenance');
  const ingress = requireObject('ingress');
  if (isObject(inputs.ingress) && typeof ingress.className !== 'string') {
    missing.push('ingress.className');
  }
  return missing;
}

function secretEnv(name: string, ref: SmrtAppChartSecretRef) {
  return {
    name,
    valueFrom: {
      secretKeyRef: { name: ref.secretName, key: ref.secretKey },
    },
  };
}

function runtimeEnv(workload: string, inputs: SmrtAppChartInputs) {
  const env: Array<ReturnType<typeof secretEnv>> = [];
  if (inputs.bindings.postgres) {
    env.push(secretEnv('DATABASE_URL', inputs.bindings.postgres.runtime));
  }
  for (const entry of inputs.env ?? []) {
    if (entry.services === undefined || entry.services.includes(workload)) {
      env.push(secretEnv(entry.name, entry));
    }
  }
  return env;
}

function workloadValues(
  workload: ComposeDeploymentWorkload,
  image: string,
  inputs: SmrtAppChartInputs,
): Record<string, unknown> {
  const overrides = own(inputs.workloads, workload.name) ?? {};
  const isWeb = workload.role === 'web';
  const role = isWeb ? 'web' : (overrides.role ?? 'background');
  const readinessProbe =
    'path' in workload.health
      ? { httpGet: { path: workload.health.path, port: workload.port } }
      : { exec: { command: workload.health.command } };
  return {
    role,
    writer: overrides.writer ?? true,
    image,
    command: [...(workload.entrypoint ?? []), ...(workload.command ?? [])],
    env: runtimeEnv(workload.name, inputs),
    // A singleton runner must stay at one replica whatever the default is.
    replicas:
      overrides.replicas ??
      (role === 'background' || role === 'schedule'
        ? 1
        : (inputs.defaults.replicas ?? 1)),
    readinessProbe,
    resources: overrides.resources ?? inputs.defaults.resources,
    terminationGracePeriodSeconds:
      overrides.terminationGracePeriodSeconds ??
      inputs.defaults.terminationGracePeriodSeconds,
    ...(isWeb ? { port: workload.port, service: { port: workload.port } } : {}),
  };
}

function runtimeValues(
  declaration: ComposeDeploymentDeclaration,
  images: Record<string, string>,
  inputs: SmrtAppChartInputs,
): Record<string, unknown> {
  const workloads: Record<string, unknown> = {};
  for (const workload of declaration.workloads) {
    workloads[workload.name] = workloadValues(
      workload,
      images[workload.name],
      inputs,
    );
  }
  return {
    workloads,
    migration: {
      image: images[declaration.migrate.service],
      command: declaration.migrate.command,
      env: inputs.bindings.postgres
        ? [secretEnv('DATABASE_URL', inputs.bindings.postgres.migration)]
        : [],
      guard: SMRT_RELEASE_GUARD,
      resources: inputs.migration?.resources ?? inputs.defaults.resources,
      terminationGracePeriodSeconds:
        inputs.migration?.terminationGracePeriodSeconds ??
        inputs.defaults.terminationGracePeriodSeconds,
    },
  };
}

/**
 * Render `smrt-app` chart values from a declaration resolved at the `deploy`
 * stage. Throws {@link SmrtAppChartValuesError} listing every problem when
 * the declaration or the inputs cannot produce a renderable release.
 */
export function renderSmrtAppChartValues(
  declaration: ComposeDeploymentDeclaration,
  inputs: SmrtAppChartInputs,
): Record<string, unknown> {
  const problems: string[] = [];

  const missing = missingInputs(inputs);
  if (missing.length > 0) {
    throw new SmrtAppChartValuesError(
      missing.map(
        (field) =>
          `The inputs have no usable \`${field}\`. See the deployment guide for the inputs file.`,
      ),
    );
  }

  const name = inputs.app.name ?? declaration.name;
  if (name === undefined || !CHART_NAME.test(name)) {
    problems.push(
      name === undefined
        ? 'The application has no name. Set `name:` at the top of the Compose file or `app.name` in the inputs.'
        : `The application name \`${name}\` must be lowercase letters, digits and hyphens, starting with a letter, at most 31 characters.`,
    );
  }

  const host = inputs.ingress.host ?? declaration.domain;
  if (host === undefined) {
    problems.push(
      'There is no hostname to serve on. Set `domain` in the `x-happyvertical` block or `ingress.host` in the inputs.',
    );
  }

  const targetImages: Record<string, string> = {};
  for (const workload of declaration.workloads) {
    if (workload.image !== undefined && DIGEST_IMAGE.test(workload.image)) {
      targetImages[workload.name] = workload.image;
    } else {
      problems.push(
        `Service \`${workload.name}\` has no image digest. Validate the Compose file at the \`deploy\` stage with the digests CI pushed.`,
      );
    }
    if (
      (workload.entrypoint ?? []).length + (workload.command ?? []).length ===
      0
    ) {
      problems.push(
        `Service \`${workload.name}\` has no \`command\` in the Compose file. The chart starts every workload with an explicit command.`,
      );
    }
    if (workload.volumes.length > 0) {
      problems.push(
        `Service \`${workload.name}\` mounts a data volume (\`${workload.volumes[0].name}\`). The chart binds existing databases and buckets and has no persistent volumes; keep that data in a platform service.`,
      );
    }
  }

  if (inputs.currentImages) {
    for (const workload of declaration.workloads) {
      const image = own(inputs.currentImages, workload.name);
      if (image === undefined || !DIGEST_IMAGE.test(image)) {
        problems.push(
          `\`currentImages.${workload.name}\` must be the image digest that service runs today.`,
        );
      }
    }
  }

  const kinds = new Set(declaration.bindings.map((binding) => binding.kind));
  if (!kinds.has('postgres')) {
    problems.push(
      'The declaration has no `postgres` binding. The chart binds exactly one existing PostgreSQL database.',
    );
  } else if (!inputs.bindings.postgres) {
    problems.push(
      'The declaration binds `postgres` but the inputs have no `bindings.postgres` Secret references.',
    );
  }
  const bucket = declaration.bindings.find(
    (binding) => binding.kind === 'bucket',
  );
  if (bucket && !inputs.bindings.bucket) {
    problems.push(
      'The declaration binds `bucket` but the inputs have no `bindings.bucket` Secret reference.',
    );
  }

  if (problems.length > 0 || name === undefined || host === undefined) {
    throw new SmrtAppChartValuesError(problems);
  }

  const { host: _host, className, ...ingress } = inputs.ingress;
  return {
    release: { ...inputs.release },
    app: { name, environment: inputs.app.environment },
    current: inputs.currentImages
      ? runtimeValues(declaration, inputs.currentImages, inputs)
      : false,
    target: runtimeValues(declaration, targetImages, inputs),
    maintenance: inputs.maintenance,
    bindings: {
      database: inputs.bindings.postgres?.runtime,
      privateBuckets:
        bucket && inputs.bindings.bucket
          ? [{ name: bucket.name, ...inputs.bindings.bucket }]
          : [],
    },
    ingress: { host, className, ...ingress },
  };
}

/**
 * Self-host rendering of the compose deployment contract: turn a resolved
 * declaration into values for the `smrt-app` chart.
 *
 * The declaration says what the application is. Everything the chart needs
 * beyond that is environment-owned and comes in as explicit inputs: release
 * identity, Secret references, resources, the maintenance responder and the
 * ingress class. Nothing here invents a default for those, and the inputs are
 * checked: they normally come from a hand-written JSON file.
 */

import type {
  ComposeDeploymentDeclaration,
  ComposeDeploymentWorkload,
} from './compose-contract.js';

/**
 * The migration guard capability the chart requires a release to declare.
 * Rendering it is a declaration, not an implementation: the application's
 * `migrate.command` has to be a wrapper that implements the guard.
 */
export const SMRT_RELEASE_GUARD = 'smrt-release-v1';

const CHART_NAME = /^[a-z][a-z0-9-]{0,30}$/;
const DIGEST_IMAGE = /^[a-zA-Z0-9./:_-]+@sha256:[a-f0-9]{64}$/;
const WORKER_ROLES = ['background', 'task', 'schedule'] as const;
// charts/smrt-app/templates/validate.yaml: "reserved workload name".
const RESERVED_WORKLOAD_NAMES = ['maintenance', 'inventory'];
const PROBE_TIMING_FIELDS = [
  'initialDelaySeconds',
  'periodSeconds',
  'timeoutSeconds',
  'failureThreshold',
  'successThreshold',
] as const;

export interface SmrtAppChartSecretRef {
  secretName: string;
  secretKey: string;
}

export interface SmrtAppChartSecretEnv extends SmrtAppChartSecretRef {
  /** Environment variable name. */
  name: string;
  /** Limit the variable to these services. Defaults to every workload. */
  services?: string[];
}

export interface SmrtAppChartResources {
  requests: Record<string, string>;
  limits: Record<string, string>;
}

/** Chart roles a contract `worker` may be rendered as. */
export type SmrtAppChartWorkerRole = (typeof WORKER_ROLES)[number];

/** Timing of the readiness probe rendered from a service's `health`. */
export type SmrtAppChartProbeTiming = Partial<
  Record<(typeof PROBE_TIMING_FIELDS)[number], number>
>;

export interface SmrtAppChartWorkloadInputs {
  /**
   * Chart role for a contract `worker`. Defaults to `background`, the
   * singleton runner. Not allowed on the web service.
   */
  role?: SmrtAppChartWorkerRole;
  /** `background` and `schedule` workloads are singletons and stay at 1. */
  replicas?: number;
  /** Whether the workload writes to the database. Defaults to `true`. */
  writer?: boolean;
  resources?: SmrtAppChartResources;
  terminationGracePeriodSeconds?: number;
  /** Kubernetes defaults apply to whatever is left out (1 s timeout, 10 s period). */
  readiness?: SmrtAppChartProbeTiming;
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
   * The runtime that is running now: the `target` block of the values
   * document the previous release was rendered to, unchanged. Leave it out
   * (or pass `false`) for a first install. It is never derived from the new
   * declaration, because the running release may differ from it in more than
   * its image digests.
   */
  current?: false | Record<string, unknown>;
  bindings: {
    /** Required when the declaration has a `postgres` binding. */
    postgres?: {
      /** Secret key holding the runtime `DATABASE_URL`. */
      runtime: SmrtAppChartSecretRef;
      /** Secret key holding the migration-only `DATABASE_URL`, in a different Secret. */
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isSecretRef(value: unknown): value is SmrtAppChartSecretRef {
  return isObject(value) && isText(value.secretName) && isText(value.secretKey);
}

/** Own keys only: a Compose service may be called `constructor` or `toString`. */
function own<T>(
  record: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function workloadInputProblems(
  field: string,
  overrides: unknown,
  isWeb: boolean,
  need: (field: string, ok: boolean, what: string) => void,
): void {
  if (!isObject(overrides)) {
    need(field, false, 'an object');
    return;
  }
  const role = overrides.role;
  if (role !== undefined) {
    if (isWeb) {
      need(
        `${field}.role`,
        false,
        "left out: the web service is always the chart's `web` workload",
      );
    } else {
      need(
        `${field}.role`,
        (WORKER_ROLES as readonly unknown[]).includes(role),
        `one of: ${WORKER_ROLES.join(', ')}`,
      );
    }
  }
  if (overrides.replicas !== undefined) {
    const singleton = !isWeb && role !== 'task';
    need(
      `${field}.replicas`,
      isPositiveInteger(overrides.replicas) &&
        (!singleton || overrides.replicas === 1),
      singleton
        ? '1: `background` and `schedule` workloads are singletons. Use `role: task` for a worker that scales'
        : 'a whole number of at least 1',
    );
  }
  need(
    `${field}.writer`,
    overrides.writer === undefined || typeof overrides.writer === 'boolean',
    '`true` or `false`',
  );
  need(
    `${field}.terminationGracePeriodSeconds`,
    overrides.terminationGracePeriodSeconds === undefined ||
      isPositiveInteger(overrides.terminationGracePeriodSeconds),
    'a whole number of seconds',
  );
  need(
    `${field}.resources`,
    overrides.resources === undefined || isObject(overrides.resources),
    'an object',
  );
  const timing = overrides.readiness;
  need(
    `${field}.readiness`,
    timing === undefined ||
      (isObject(timing) &&
        Object.entries(timing).every(
          ([key, value]) =>
            (PROBE_TIMING_FIELDS as readonly string[]).includes(key) &&
            typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= (key === 'initialDelaySeconds' ? 0 : 1),
        )),
    `an object of whole numbers using only: ${PROBE_TIMING_FIELDS.join(', ')}`,
  );
}

/**
 * Check the shape of the inputs and that they only name services the
 * declaration has. Returns one sentence per problem.
 */
function inputProblems(
  inputs: unknown,
  declaration: ComposeDeploymentDeclaration,
): string[] {
  if (!isObject(inputs)) {
    return ['The inputs must be a JSON object. See the deployment guide.'];
  }
  const problems: string[] = [];
  const need = (field: string, ok: boolean, what: string): void => {
    if (!ok) problems.push(`\`${field}\` must be ${what}.`);
  };
  const services = declaration.workloads.map((workload) => workload.name);
  const web = declaration.workloads.find((item) => item.role === 'web')?.name;

  need('release', isObject(inputs.release), 'an object');

  if (isObject(inputs.app)) {
    need('app.environment', isText(inputs.app.environment), 'a name');
    need(
      'app.name',
      inputs.app.name === undefined || isText(inputs.app.name),
      'a name',
    );
  } else {
    need('app', false, 'an object');
  }

  need(
    'current',
    inputs.current === undefined ||
      inputs.current === false ||
      isObject(inputs.current),
    "left out or `false` for a first install, or the previous release's `target` block",
  );

  let migrationSecret: string | undefined;
  if (isObject(inputs.bindings)) {
    const postgres = inputs.bindings.postgres;
    if (postgres !== undefined) {
      if (
        isObject(postgres) &&
        isSecretRef(postgres.runtime) &&
        isSecretRef(postgres.migration)
      ) {
        migrationSecret = postgres.migration.secretName;
        need(
          'bindings.postgres.migration.secretName',
          postgres.migration.secretName !== postgres.runtime.secretName,
          'a different Secret from `bindings.postgres.runtime.secretName`: the migration and the running application never share credentials',
        );
      } else {
        need(
          'bindings.postgres',
          false,
          '`{ runtime, migration }`, each with `secretName` and `secretKey`',
        );
      }
    }
    const bucket = inputs.bindings.bucket;
    if (bucket === undefined || isSecretRef(bucket)) {
      need(
        'bindings.bucket.secretName',
        bucket === undefined || bucket.secretName !== migrationSecret,
        'a runtime Secret, not the migration Secret',
      );
    } else {
      need(
        'bindings.bucket',
        false,
        'an object with `secretName` and `secretKey`',
      );
    }
  } else {
    need('bindings', false, 'an object');
  }

  if (Array.isArray(inputs.env)) {
    const names = new Set<string>(
      isObject(inputs.bindings) && inputs.bindings.postgres !== undefined
        ? ['DATABASE_URL']
        : [],
    );
    inputs.env.forEach((entry, index) => {
      const field = `env[${index}]`;
      if (!isObject(entry) || !isText(entry.name) || !isSecretRef(entry)) {
        need(
          field,
          false,
          'an object with `name`, `secretName` and `secretKey`',
        );
        return;
      }
      // Kubernetes keeps the last of two variables with one name, which
      // would silently replace the bound database credential or an earlier
      // entry.
      need(
        `${field}.name`,
        !names.has(entry.name),
        entry.name === 'DATABASE_URL'
          ? 'something other than `DATABASE_URL`, which the `postgres` binding sets'
          : `unique: another entry already sets \`${entry.name}\``,
      );
      names.add(entry.name);
      need(
        `${field}.secretName`,
        entry.secretName !== migrationSecret,
        'a runtime Secret, not the migration Secret',
      );
      need(
        `${field}.services`,
        entry.services === undefined ||
          (Array.isArray(entry.services) &&
            entry.services.length > 0 &&
            entry.services.every((name) => services.includes(name))),
        `left out, or a list naming one or more of: ${services.join(', ')}`,
      );
    });
  } else {
    need('env', inputs.env === undefined, 'a list');
  }

  if (isObject(inputs.defaults)) {
    need(
      'defaults.resources',
      isObject(inputs.defaults.resources),
      'an object',
    );
    need(
      'defaults.terminationGracePeriodSeconds',
      isPositiveInteger(inputs.defaults.terminationGracePeriodSeconds),
      'a whole number of seconds',
    );
    need(
      'defaults.replicas',
      inputs.defaults.replicas === undefined ||
        isPositiveInteger(inputs.defaults.replicas),
      'a whole number of at least 1',
    );
  } else {
    need('defaults', false, 'an object');
  }

  if (isObject(inputs.workloads)) {
    for (const [name, overrides] of Object.entries(inputs.workloads)) {
      if (services.includes(name)) {
        workloadInputProblems(
          `workloads.${name}`,
          overrides,
          name === web,
          need,
        );
      } else {
        problems.push(
          `\`workloads.${name}\` names a service the declaration does not have. Its web and worker services are: ${services.join(', ')}.`,
        );
      }
    }
  } else {
    need(
      'workloads',
      inputs.workloads === undefined,
      'an object keyed by service name',
    );
  }

  need(
    'migration',
    inputs.migration === undefined || isObject(inputs.migration),
    'an object',
  );
  need('maintenance', isObject(inputs.maintenance), 'an object');
  if (isObject(inputs.ingress)) {
    need('ingress.className', isText(inputs.ingress.className), 'a name');
    need(
      'ingress.host',
      inputs.ingress.host === undefined || isText(inputs.ingress.host),
      'a hostname',
    );
  } else {
    need('ingress', false, 'an object');
  }
  return problems;
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
  const probe =
    'path' in workload.health
      ? { httpGet: { path: workload.health.path, port: workload.port } }
      : { exec: { command: workload.health.command } };
  return {
    role,
    writer: overrides.writer ?? true,
    image,
    // The chart's `command` replaces the image's entrypoint, so the complete
    // argv is the declared entrypoint followed by the declared command.
    command: [...(workload.entrypoint ?? []), ...(workload.command ?? [])],
    env: runtimeEnv(workload.name, inputs),
    // A singleton runner stays at one replica whatever the default is.
    replicas:
      role === 'background' || role === 'schedule'
        ? 1
        : (overrides.replicas ?? inputs.defaults.replicas ?? 1),
    readinessProbe: { ...probe, ...(overrides.readiness ?? {}) },
    resources: overrides.resources ?? inputs.defaults.resources,
    terminationGracePeriodSeconds:
      overrides.terminationGracePeriodSeconds ??
      inputs.defaults.terminationGracePeriodSeconds,
    ...(isWeb ? { port: workload.port, service: { port: workload.port } } : {}),
  };
}

/**
 * Render `smrt-app` chart values from a declaration resolved at the `deploy`
 * stage. Throws {@link SmrtAppChartValuesError} listing every problem when
 * the declaration or the inputs cannot produce a faithful release.
 *
 * `target` is rendered from the declaration. `current` is whatever the caller
 * passes as the running release and is never synthesized.
 */
export function renderSmrtAppChartValues(
  declaration: ComposeDeploymentDeclaration,
  inputs: SmrtAppChartInputs,
): Record<string, unknown> {
  const problems = inputProblems(inputs, declaration);
  if (problems.length > 0) throw new SmrtAppChartValuesError(problems);

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

  const images: Record<string, string> = {};
  for (const workload of declaration.workloads) {
    if (RESERVED_WORKLOAD_NAMES.includes(workload.name)) {
      problems.push(
        `Service \`${workload.name}\` uses a name the chart keeps for its own resources (${RESERVED_WORKLOAD_NAMES.join(', ')}). Rename the service.`,
      );
    }
    if (workload.image !== undefined && DIGEST_IMAGE.test(workload.image)) {
      images[workload.name] = workload.image;
    } else {
      problems.push(
        `Service \`${workload.name}\` has no image digest. Validate the Compose file at the \`deploy\` stage with the digests CI pushed.`,
      );
    }
    if (workload.entrypoint === undefined) {
      problems.push(
        `Service \`${workload.name}\` leaves its entrypoint to the image. The chart starts a workload with exactly the command it is given and never runs the image's own entrypoint, so the Compose file has to state it: add \`entrypoint:\` to the service, naming the image's entrypoint, or \`entrypoint: []\` when \`command\` is complete on its own.`,
      );
    } else if (
      workload.entrypoint.length + (workload.command ?? []).length ===
      0
    ) {
      problems.push(
        `Service \`${workload.name}\` has an empty \`entrypoint\` and no \`command\`, so there is nothing to start.`,
      );
    }
    if (workload.volumes.length > 0) {
      problems.push(
        `Service \`${workload.name}\` mounts a data volume (\`${workload.volumes[0].name}\`). The chart binds existing databases and buckets and has no persistent volumes; keep that data in a platform service.`,
      );
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

  const workloads: Record<string, unknown> = {};
  for (const workload of declaration.workloads) {
    workloads[workload.name] = workloadValues(
      workload,
      images[workload.name],
      inputs,
    );
  }
  const { host: _host, className, ...ingress } = inputs.ingress;
  return {
    release: { ...inputs.release },
    app: { name, environment: inputs.app.environment },
    current: inputs.current ? inputs.current : false,
    target: {
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
    },
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

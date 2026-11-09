import { describe, expect, it } from 'vitest';
import {
  renderSmrtAppChartValues,
  type SmrtAppChartInputs,
  SmrtAppChartValuesError,
} from './chart-values.js';
import {
  type ComposeDeploymentDeclaration,
  validateComposeDeployment,
} from './compose-contract.js';

type Doc = Record<string, any>;

const digest = (name: string, fill = 'a') =>
  `ghcr.io/acme/${name}@sha256:${fill.repeat(64)}`;

function stack(): Doc {
  return {
    name: 'acme',
    'x-happyvertical': {
      version: 1,
      preset: 'smrt',
      domain: 'app.example.com',
      migrate: { command: ['pnpm', 'exec', 'smrt', 'db:migrate'] },
    },
    services: {
      web: {
        build: '.',
        entrypoint: ['docker-entrypoint.sh'],
        command: 'node build',
        ports: ['3000:3000'],
        'x-happyvertical': { role: 'web', health: { path: '/health' } },
      },
      worker: {
        build: '.',
        entrypoint: [],
        command: ['pnpm', 'exec', 'smrt', 'app', 'worker', 'task'],
        'x-happyvertical': {
          role: 'worker',
          health: { command: ['pnpm', 'exec', 'smrt', 'app', 'doctor'] },
        },
      },
      database: {
        image: 'postgres:18-alpine',
        'x-happyvertical': { binding: 'postgres' },
      },
      storage: {
        image: 'minio/minio',
        'x-happyvertical': { binding: 'bucket' },
      },
    },
  };
}

function declare(
  mutate: (doc: Doc) => void = () => {},
  stage: 'declare' | 'deploy' = 'deploy',
): ComposeDeploymentDeclaration {
  const doc = stack();
  mutate(doc);
  const images: Record<string, string> = {};
  for (const [name, service] of Object.entries<Doc>(doc.services)) {
    if (service['x-happyvertical']?.role) {
      images[name] = digest(name, name === 'web' ? 'a' : 'b');
    }
  }
  const result = validateComposeDeployment(doc, {
    stage,
    images: stage === 'deploy' ? images : undefined,
  });
  expect(result.errors).toEqual([]);
  return result.declaration as ComposeDeploymentDeclaration;
}

const resources = {
  requests: { cpu: '100m', memory: '128Mi' },
  limits: { cpu: '1', memory: '512Mi' },
};

function inputs(
  overrides: Partial<SmrtAppChartInputs> = {},
): SmrtAppChartInputs {
  return {
    release: {
      id: 'release-001',
      phase: 'maintenance',
      sequence: 0,
      attempt: 1,
    },
    app: { environment: 'production' },
    bindings: {
      postgres: {
        runtime: { secretName: 'app-runtime-v1', secretKey: 'uri' },
        migration: { secretName: 'app-migration-v1', secretKey: 'uri' },
      },
      bucket: { secretName: 'app-assets-v1', secretKey: 'config' },
    },
    defaults: { resources, terminationGracePeriodSeconds: 90 },
    maintenance: {
      image: digest('nginx', 'c'),
      command: ['nginx', '-g', 'daemon off;'],
      port: 8080,
      http: { path: '/', status: 503, body: 'Maintenance' },
    },
    ingress: { className: 'nginx' },
    ...overrides,
  };
}

function problems(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SmrtAppChartValuesError);
    return (error as SmrtAppChartValuesError).problems;
  }
  throw new Error('expected renderSmrtAppChartValues to throw');
}

const render = (
  overrides?: Partial<SmrtAppChartInputs>,
  mutate?: (doc: Doc) => void,
) => renderSmrtAppChartValues(declare(mutate), inputs(overrides)) as Doc;

const refused = (
  overrides: Record<string, unknown>,
  mutate?: (doc: Doc) => void,
) =>
  problems(() =>
    renderSmrtAppChartValues(declare(mutate), {
      ...inputs(),
      ...overrides,
    } as never),
  );

describe('renderSmrtAppChartValues', () => {
  it('renders a first install from the declaration and the environment inputs', () => {
    const databaseUrl = {
      name: 'DATABASE_URL',
      valueFrom: { secretKeyRef: { name: 'app-runtime-v1', key: 'uri' } },
    };
    expect(render()).toEqual({
      release: {
        id: 'release-001',
        phase: 'maintenance',
        sequence: 0,
        attempt: 1,
      },
      app: { name: 'acme', environment: 'production' },
      current: false,
      target: {
        workloads: {
          web: {
            role: 'web',
            writer: true,
            image: digest('web'),
            command: ['docker-entrypoint.sh', 'node', 'build'],
            env: [databaseUrl],
            replicas: 1,
            readinessProbe: { httpGet: { path: '/health', port: 3000 } },
            resources,
            terminationGracePeriodSeconds: 90,
            port: 3000,
            service: { port: 3000 },
          },
          worker: {
            role: 'background',
            writer: true,
            image: digest('worker', 'b'),
            command: ['pnpm', 'exec', 'smrt', 'app', 'worker', 'task'],
            env: [databaseUrl],
            replicas: 1,
            readinessProbe: {
              exec: { command: ['pnpm', 'exec', 'smrt', 'app', 'doctor'] },
            },
            resources,
            terminationGracePeriodSeconds: 90,
          },
        },
        migration: {
          image: digest('web'),
          command: ['pnpm', 'exec', 'smrt', 'db:migrate'],
          env: [
            {
              name: 'DATABASE_URL',
              valueFrom: {
                secretKeyRef: { name: 'app-migration-v1', key: 'uri' },
              },
            },
          ],
          guard: 'smrt-release-v1',
          resources,
          terminationGracePeriodSeconds: 90,
        },
      },
      maintenance: inputs().maintenance,
      bindings: {
        database: { secretName: 'app-runtime-v1', secretKey: 'uri' },
        privateBuckets: [
          { name: 'storage', secretName: 'app-assets-v1', secretKey: 'config' },
        ],
      },
      ingress: { host: 'app.example.com', className: 'nginx' },
    });
  });

  it('passes the running release through as current and never synthesizes it', () => {
    // The running release differs from the new declaration in more than its
    // digests: an old command, an old Secret and a service since removed.
    const previousTarget = {
      workloads: {
        web: { image: digest('web', 'd'), command: ['node', 'old-build'] },
        legacy: { image: digest('legacy', 'e') },
      },
      migration: { image: digest('web', 'd') },
    };
    const values = render({ current: previousTarget });
    expect(values.current).toBe(previousTarget);
    expect(values.target.workloads.web.command).toEqual([
      'docker-entrypoint.sh',
      'node',
      'build',
    ]);
    expect(render({ current: false }).current).toBe(false);
  });

  it('applies defaults, per-service overrides and scoped environment', () => {
    const values = render({
      app: { name: 'acme-prod', environment: 'production' },
      defaults: { resources, terminationGracePeriodSeconds: 90, replicas: 2 },
      workloads: {
        worker: {
          role: 'task',
          replicas: 3,
          writer: false,
          terminationGracePeriodSeconds: 270,
          readiness: { periodSeconds: 60, timeoutSeconds: 30 },
        },
      },
      env: [
        { name: 'SESSION_SECRET', secretName: 'app-config-v1', secretKey: 's' },
        {
          name: 'QUEUE',
          secretName: 'app-config-v1',
          secretKey: 'q',
          services: ['worker'],
        },
      ],
      migration: { terminationGracePeriodSeconds: 300 },
      ingress: {
        className: 'nginx',
        host: 'www.example.org',
        tlsSecretName: 'www-tls',
      },
    });
    const { web, worker } = values.target.workloads;
    expect(values.app.name).toBe('acme-prod');
    expect(web.replicas).toBe(2);
    expect(web.env.map((entry: Doc) => entry.name)).toEqual([
      'DATABASE_URL',
      'SESSION_SECRET',
    ]);
    expect(worker).toMatchObject({
      role: 'task',
      replicas: 3,
      writer: false,
      terminationGracePeriodSeconds: 270,
      readinessProbe: {
        exec: { command: ['pnpm', 'exec', 'smrt', 'app', 'doctor'] },
        periodSeconds: 60,
        timeoutSeconds: 30,
      },
    });
    expect(worker.env.map((entry: Doc) => entry.name)).toEqual([
      'DATABASE_URL',
      'SESSION_SECRET',
      'QUEUE',
    ]);
    expect(values.target.migration.terminationGracePeriodSeconds).toBe(300);
    expect(values.ingress).toEqual({
      host: 'www.example.org',
      className: 'nginx',
      tlsSecretName: 'www-tls',
    });
  });

  it('keeps singleton workers at one replica and refuses to scale them', () => {
    const values = render({
      defaults: { resources, terminationGracePeriodSeconds: 90, replicas: 2 },
    });
    expect(values.target.workloads.worker.replicas).toBe(1);
    for (const role of [undefined, 'background', 'schedule'] as const) {
      expect(refused({ workloads: { worker: { role, replicas: 2 } } })).toEqual(
        [expect.stringContaining('`workloads.worker.replicas` must be 1')],
      );
    }
  });

  it('renders a command health check on the web service as an exec probe', () => {
    const values = render(undefined, (doc) => {
      doc.services.web['x-happyvertical'].health = { command: ['true'] };
    });
    expect(values.target.workloads.web.readinessProbe).toEqual({
      exec: { command: ['true'] },
    });
  });

  it('requires the Compose file to state the entrypoint the chart replaces', () => {
    // Compose runs the image entrypoint with `command` as its arguments; the
    // chart runs exactly the command it is given. Only an explicit entrypoint
    // makes the two start the same process.
    expect(
      refused({}, (doc) => {
        delete doc.services.web.entrypoint;
      }),
    ).toEqual([
      expect.stringContaining(
        'Service `web` leaves its entrypoint to the image',
      ),
    ]);
    expect(
      refused({}, (doc) => {
        delete doc.services.worker.command;
      }),
    ).toEqual([expect.stringContaining('empty `entrypoint` and no `command`')]);
    const values = render(undefined, (doc) => {
      doc.services.web.entrypoint = ['tini', '--', 'node'];
      delete doc.services.web.command;
    });
    expect(values.target.workloads.web.command).toEqual(['tini', '--', 'node']);
  });

  it('reads per-service inputs by own key, whatever a service is called', () => {
    const rename = (doc: Doc) => {
      doc.services.constructor = doc.services.worker;
      delete doc.services.worker;
    };
    expect(
      render(undefined, rename).target.workloads.constructor,
    ).toMatchObject({ role: 'background', writer: true, replicas: 1 });
    expect(
      render(
        {
          workloads: Object.fromEntries([
            ['constructor', { role: 'task' }],
          ]) as SmrtAppChartInputs['workloads'],
        },
        rename,
      ).target.workloads.constructor.role,
    ).toBe('task');
  });

  it('refuses a declaration that was not resolved to image digests', () => {
    expect(
      problems(() =>
        renderSmrtAppChartValues(declare(undefined, 'declare'), inputs()),
      ),
    ).toEqual([
      expect.stringContaining('Service `web` has no image digest'),
      expect.stringContaining('Service `worker` has no image digest'),
    ]);
  });

  it('lists every declaration problem at once', () => {
    expect(
      refused({ bindings: {} }, (doc) => {
        delete doc.name;
        delete doc['x-happyvertical'].domain;
        delete doc.services.web.entrypoint;
      }),
    ).toEqual([
      expect.stringContaining('The application has no name'),
      expect.stringContaining('There is no hostname'),
      expect.stringContaining('Service `web` leaves its entrypoint'),
      expect.stringContaining('no `bindings.postgres`'),
      expect.stringContaining('no `bindings.bucket`'),
    ]);
  });

  it('names missing inputs instead of failing on undefined', () => {
    for (const value of [null, [], 'inputs.json']) {
      expect(
        problems(() => renderSmrtAppChartValues(declare(), value as never)),
      ).toEqual([expect.stringContaining('must be a JSON object')]);
    }
    expect(
      problems(() => renderSmrtAppChartValues(declare(), {} as never)),
    ).toEqual(
      ['release', 'app', 'bindings', 'defaults', 'maintenance', 'ingress'].map(
        (field) => expect.stringContaining(`\`${field}\` must be`),
      ),
    );
    expect(refused({ app: {}, defaults: {}, ingress: {} })).toEqual(
      [
        'app.environment',
        'defaults.resources',
        'defaults.terminationGracePeriodSeconds',
        'ingress.className',
      ].map((field) => expect.stringContaining(`\`${field}\` must be`)),
    );
  });

  it('refuses half-filled or unsafe Secret references', () => {
    const runtime = { secretName: 'app-runtime-v1', secretKey: 'uri' };
    for (const postgres of [
      {},
      { runtime },
      { runtime, migration: { secretName: 'app-migration-v1' } },
      'app-runtime-v1',
    ]) {
      expect(refused({ bindings: { postgres } })).toEqual([
        expect.stringContaining('`bindings.postgres` must be'),
      ]);
    }
    // The chart refuses runtime and migration credentials in one Secret.
    expect(
      refused({ bindings: { postgres: { runtime, migration: runtime } } }),
    ).toEqual([
      expect.stringContaining(
        '`bindings.postgres.migration.secretName` must be a different Secret',
      ),
    ]);
    expect(
      refused({
        env: [{ name: 'X', secretName: 'app-migration-v1', secretKey: 'k' }],
      }),
    ).toEqual([
      expect.stringContaining('`env[0].secretName` must be a runtime Secret'),
    ]);
    expect(
      refused({
        bindings: { ...inputs().bindings, bucket: { secretName: 'b' } },
      }),
    ).toEqual([expect.stringContaining('`bindings.bucket` must be')]);
    for (const env of ['X', [{ name: 'X' }], [null]]) {
      expect(refused({ env })).toEqual([
        expect.stringContaining(
          Array.isArray(env) ? '`env[0]` must be' : '`env` must be',
        ),
      ]);
    }
  });

  it('refuses environment and overrides aimed at services that do not exist', () => {
    const entry = {
      name: 'QUEUE',
      secretName: 'app-config-v1',
      secretKey: 'q',
    };
    // A string would match other service names by substring.
    for (const services of ['worker', [], ['wroker'], ['web', 'database']]) {
      expect(refused({ env: [{ ...entry, services }] })).toEqual([
        expect.stringContaining('`env[0].services` must be'),
      ]);
    }
    expect(refused({ workloads: { wroker: { role: 'task' } } })).toEqual([
      expect.stringContaining(
        '`workloads.wroker` names a service the declaration does not have',
      ),
    ]);
    expect(refused({ workloads: { database: {} } })).toEqual([
      expect.stringContaining('`workloads.database` names a service'),
    ]);
  });

  it('refuses overrides the chart would reject', () => {
    expect(refused({ workloads: { worker: { role: 'web' } } })).toEqual([
      expect.stringContaining(
        '`workloads.worker.role` must be one of: background, task, schedule',
      ),
    ]);
    expect(refused({ workloads: { web: { role: 'task' } } })).toEqual([
      expect.stringContaining('`workloads.web.role` must be left out'),
    ]);
    expect(refused({ workloads: { web: { replicas: 0 } } })).toEqual([
      expect.stringContaining(
        '`workloads.web.replicas` must be a whole number',
      ),
    ]);
    for (const readiness of [
      { timeoutSeconds: 0 },
      { timeoutSeconds: '30' },
      { httpGet: { path: '/' } },
      30,
    ]) {
      expect(refused({ workloads: { worker: { readiness } } })).toEqual([
        expect.stringContaining('`workloads.worker.readiness` must be'),
      ]);
    }
    expect(refused({ current: true })).toEqual([
      expect.stringContaining('`current` must be'),
    ]);
  });

  it('refuses what the chart cannot render', () => {
    expect(
      refused({}, (doc) => {
        delete doc.services.database;
      }),
    ).toEqual([expect.stringContaining('no `postgres` binding')]);
    expect(
      refused({}, (doc) => {
        doc.volumes = { uploads: null };
        doc.services.web.volumes = ['uploads:/data'];
      }),
    ).toEqual([expect.stringContaining('mounts a data volume (`uploads`)')]);
    expect(
      refused({ app: { name: 'Acme App', environment: 'production' } }),
    ).toEqual([expect.stringContaining('The application name `Acme App`')]);
  });
});

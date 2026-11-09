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
        command: 'node build',
        ports: ['3000:3000'],
        'x-happyvertical': { role: 'web', health: { path: '/health' } },
      },
      worker: {
        build: '.',
        entrypoint: ['pnpm', 'exec'],
        command: ['smrt', 'app', 'worker', 'task'],
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
  const result = validateComposeDeployment(doc, {
    stage,
    images:
      stage === 'deploy'
        ? { web: digest('web'), worker: digest('worker', 'b') }
        : undefined,
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
    maintenance: { image: digest('nginx', 'c'), port: 8080 },
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

describe('renderSmrtAppChartValues', () => {
  it('renders a first install from the declaration and the environment inputs', () => {
    const databaseUrl = {
      name: 'DATABASE_URL',
      valueFrom: { secretKeyRef: { name: 'app-runtime-v1', key: 'uri' } },
    };
    expect(renderSmrtAppChartValues(declare(), inputs())).toEqual({
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
            command: ['node', 'build'],
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
      maintenance: { image: digest('nginx', 'c'), port: 8080 },
      bindings: {
        database: { secretName: 'app-runtime-v1', secretKey: 'uri' },
        privateBuckets: [
          { name: 'storage', secretName: 'app-assets-v1', secretKey: 'config' },
        ],
      },
      ingress: { host: 'app.example.com', className: 'nginx' },
    });
  });

  it('renders the running release as current when its digests are given', () => {
    const values = renderSmrtAppChartValues(
      declare(),
      inputs({
        currentImages: {
          web: digest('web', 'd'),
          worker: digest('worker', 'e'),
        },
      }),
    ) as Doc;
    expect(values.current.workloads.web.image).toBe(digest('web', 'd'));
    expect(values.current.workloads.worker.image).toBe(digest('worker', 'e'));
    expect(values.current.migration.image).toBe(digest('web', 'd'));
    expect(values.target.workloads.web.image).toBe(digest('web'));
  });

  it('applies defaults, per-service overrides and scoped environment', () => {
    const values = renderSmrtAppChartValues(
      declare(),
      inputs({
        app: { name: 'acme-prod', environment: 'production' },
        defaults: { resources, terminationGracePeriodSeconds: 90, replicas: 2 },
        workloads: {
          worker: {
            role: 'task',
            replicas: 3,
            writer: false,
            terminationGracePeriodSeconds: 270,
          },
        },
        env: [
          {
            name: 'SESSION_SECRET',
            secretName: 'app-config-v1',
            secretKey: 's',
          },
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
      }),
    ) as Doc;
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

  it('keeps a singleton worker at one replica whatever the default is', () => {
    const values = renderSmrtAppChartValues(
      declare(),
      inputs({
        defaults: { resources, terminationGracePeriodSeconds: 90, replicas: 2 },
      }),
    ) as Doc;
    expect(values.target.workloads.worker.replicas).toBe(1);
  });

  it('reads per-service inputs by own key, whatever a service is called', () => {
    const doc = stack();
    doc.services.constructor = doc.services.worker;
    delete doc.services.worker;
    const result = validateComposeDeployment(doc, {
      stage: 'deploy',
      images: { web: digest('web'), constructor: digest('worker', 'b') },
    });
    expect(result.errors).toEqual([]);
    const values = renderSmrtAppChartValues(
      result.declaration as ComposeDeploymentDeclaration,
      inputs(),
    ) as Doc;
    expect(values.target.workloads.constructor).toMatchObject({
      role: 'background',
      writer: true,
      replicas: 1,
    });
    expect(
      problems(() =>
        renderSmrtAppChartValues(
          result.declaration as ComposeDeploymentDeclaration,
          inputs({ currentImages: { web: digest('web', 'd') } }),
        ),
      ),
    ).toEqual([
      expect.stringContaining(
        '`currentImages.constructor` must be the image digest',
      ),
    ]);
  });

  it('renders a command health check on the web service as an exec probe', () => {
    const values = renderSmrtAppChartValues(
      declare((doc) => {
        doc.services.web['x-happyvertical'].health = { command: ['true'] };
      }),
      inputs(),
    ) as Doc;
    expect(values.target.workloads.web.readinessProbe).toEqual({
      exec: { command: ['true'] },
    });
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

  it('lists every missing input at once', () => {
    const found = problems(() =>
      renderSmrtAppChartValues(
        declare((doc) => {
          delete doc.name;
          delete doc['x-happyvertical'].domain;
          delete doc.services.web.command;
        }),
        inputs({ bindings: {}, currentImages: { web: 'web:latest' } }),
      ),
    );
    expect(found).toEqual([
      expect.stringContaining('The application has no name'),
      expect.stringContaining('There is no hostname'),
      expect.stringContaining('Service `web` has no `command`'),
      expect.stringContaining('`currentImages.web` must be the image digest'),
      expect.stringContaining(
        '`currentImages.worker` must be the image digest',
      ),
      expect.stringContaining('no `bindings.postgres`'),
      expect.stringContaining('no `bindings.bucket`'),
    ]);
  });

  it('names missing inputs instead of failing on undefined', () => {
    for (const value of [null, [], 'inputs.json']) {
      expect(
        problems(() => renderSmrtAppChartValues(declare(), value as never)),
      ).toEqual([expect.stringContaining('`inputs`')]);
    }
    expect(
      problems(() => renderSmrtAppChartValues(declare(), {} as never)),
    ).toEqual(
      ['release', 'app', 'bindings', 'defaults', 'maintenance', 'ingress'].map(
        (field) => expect.stringContaining(`\`${field}\``),
      ),
    );
    expect(
      problems(() =>
        renderSmrtAppChartValues(declare(), {
          ...inputs(),
          app: {},
          defaults: {},
          ingress: {},
        } as never),
      ),
    ).toEqual(
      [
        'app.environment',
        'defaults.resources',
        'defaults.terminationGracePeriodSeconds',
        'ingress.className',
      ].map((field) => expect.stringContaining(`\`${field}\``)),
    );
  });

  it('refuses what the chart cannot render', () => {
    expect(
      problems(() =>
        renderSmrtAppChartValues(
          declare((doc) => {
            delete doc.services.database;
          }),
          inputs(),
        ),
      ),
    ).toEqual([expect.stringContaining('no `postgres` binding')]);
    expect(
      problems(() =>
        renderSmrtAppChartValues(
          declare((doc) => {
            doc.volumes = { uploads: null };
            doc.services.web.volumes = ['uploads:/data'];
          }),
          inputs(),
        ),
      ),
    ).toEqual([expect.stringContaining('mounts a data volume (`uploads`)')]);
    expect(
      problems(() =>
        renderSmrtAppChartValues(
          declare(),
          inputs({ app: { name: 'Acme App', environment: 'production' } }),
        ),
      ),
    ).toEqual([expect.stringContaining('The application name `Acme App`')]);
  });
});

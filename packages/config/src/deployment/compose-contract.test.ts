import { describe, expect, it } from 'vitest';
import {
  type ComposeDeploymentIssueCode,
  type ComposeDeploymentOptions,
  formatComposeDeploymentReport,
  validateComposeDeployment,
} from './compose-contract.js';

type Doc = Record<string, any>;

const digest = (name: string, fill = 'a') =>
  `ghcr.io/acme/${name}@sha256:${fill.repeat(64)}`;

/** A complete, valid declaration: web, worker, a local-only job, postgres. */
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
        ports: ['${WEB_PORT:-3000}:3000'],
        'x-happyvertical': {
          role: 'web',
          health: { path: '/api/_runtime/health' },
        },
      },
      worker: {
        build: '.',
        command: ['pnpm', 'exec', 'smrt', 'app', 'worker', 'task'],
        'x-happyvertical': {
          role: 'worker',
          health: { command: ['pnpm', 'exec', 'smrt', 'app', 'doctor'] },
        },
      },
      migrate: { build: { context: '.', target: 'build' } },
      database: {
        image: 'postgres:18-alpine',
        volumes: ['postgres-data:/var/lib/postgresql'],
        'x-happyvertical': { binding: 'postgres' },
      },
    },
    volumes: { 'postgres-data': null },
  };
}

function check(
  mutate: (doc: Doc) => void = () => {},
  options?: ComposeDeploymentOptions,
) {
  const doc = stack();
  mutate(doc);
  return validateComposeDeployment(doc, options);
}

function codes(
  mutate: (doc: Doc) => void,
  options?: ComposeDeploymentOptions,
): ComposeDeploymentIssueCode[] {
  return check(mutate, options).errors.map((issue) => issue.code);
}

const deploy: ComposeDeploymentOptions = {
  stage: 'deploy',
  images: { web: digest('web'), worker: digest('worker', 'b') },
};

describe('validateComposeDeployment: a valid declaration', () => {
  it('resolves the declaration at the declare stage', () => {
    const result = check();
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.declaration).toEqual({
      version: 1,
      preset: 'smrt',
      stage: 'declare',
      name: 'acme',
      domain: 'app.example.com',
      migrate: {
        service: 'web',
        command: ['pnpm', 'exec', 'smrt', 'db:migrate'],
      },
      workloads: [
        {
          name: 'web',
          role: 'web',
          command: ['node', 'build'],
          port: 3000,
          health: { path: '/api/_runtime/health' },
          volumes: [],
        },
        {
          name: 'worker',
          role: 'worker',
          command: ['pnpm', 'exec', 'smrt', 'app', 'worker', 'task'],
          health: { command: ['pnpm', 'exec', 'smrt', 'app', 'doctor'] },
          volumes: [],
        },
      ],
      bindings: [{ name: 'database', kind: 'postgres' }],
      localOnly: ['migrate'],
    });
  });

  it('reports an unannotated service as local-only without failing', () => {
    const result = check();
    expect(result.warnings.map((issue) => issue.code)).toEqual([
      'local-only-service',
    ]);
    expect(result.warnings[0].service).toBe('migrate');
  });

  it('resolves supplied digests at the deploy stage, including the migration image', () => {
    const result = check(undefined, deploy);
    expect(result.errors).toEqual([]);
    expect(result.declaration?.stage).toBe('deploy');
    expect(
      result.declaration?.workloads.map((workload) => workload.image),
    ).toEqual([digest('web'), digest('worker', 'b')]);
    expect(result.declaration?.migrate.image).toBe(digest('web'));
  });

  it('accepts a digest written in the file at the deploy stage', () => {
    const result = check(
      (doc) => {
        delete doc.services.web.build;
        doc.services.web.image = digest('web', 'c');
      },
      { stage: 'deploy', images: { worker: digest('worker') } },
    );
    expect(result.errors).toEqual([]);
    expect(result.declaration?.workloads[0].image).toBe(digest('web', 'c'));
  });

  it('runs the migration in the named service image', () => {
    const result = check((doc) => {
      doc['x-happyvertical'].migrate.service = 'worker';
    }, deploy);
    expect(result.declaration?.migrate).toEqual({
      service: 'worker',
      command: ['pnpm', 'exec', 'smrt', 'db:migrate'],
      image: digest('worker', 'b'),
    });
  });

  it('treats domain as optional', () => {
    const result = check((doc) => {
      delete doc['x-happyvertical'].domain;
    });
    expect(result.ok).toBe(true);
    expect(result.declaration).not.toHaveProperty('domain');
  });

  it('reads the ingress port from long syntax and from expose', () => {
    expect(
      check((doc) => {
        doc.services.web.ports = [{ target: 8080, published: 80 }];
      }).declaration?.workloads[0].port,
    ).toBe(8080);
    expect(
      check((doc) => {
        delete doc.services.web.ports;
        doc.services.web.expose = ['3000/tcp'];
      }).declaration?.workloads[0].port,
    ).toBe(3000);
  });

  it('carries declared data volumes and ignores tmpfs scratch', () => {
    const result = check((doc) => {
      doc.volumes.uploads = {};
      doc.services.web.volumes = [
        'uploads:/data:ro',
        { type: 'volume', source: 'uploads', target: '/more' },
        { type: 'tmpfs', target: '/tmp' },
      ];
    });
    expect(result.errors).toEqual([]);
    expect(result.declaration?.workloads[0].volumes).toEqual([
      { name: 'uploads', target: '/data', readOnly: true },
      { name: 'uploads', target: '/more', readOnly: false },
    ]);
  });
});

describe('validateComposeDeployment: the local-first shape', () => {
  // One process, SQLite on a declared data volume, no worker, no platform
  // service: the other shape version 1 has to express besides the
  // web + worker + postgres stack above. This proves the contract can
  // express it; nothing here claims an application can run this way today.
  const localFirst = (): Doc => ({
    name: 'notes',
    'x-happyvertical': {
      version: 1,
      preset: 'smrt',
      migrate: { command: ['pnpm', 'exec', 'smrt', 'app', 'migrate'] },
    },
    services: {
      web: {
        build: '.',
        command: ['node', 'server.js'],
        ports: ['3000:3000'],
        volumes: ['data:/data'],
        'x-happyvertical': {
          role: 'web',
          health: { path: '/api/_runtime/health' },
        },
      },
    },
    volumes: { data: null },
  });

  it('is a valid declaration with one web service and its data volume', () => {
    const result = validateComposeDeployment(localFirst());
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.declaration).toMatchObject({
      preset: 'smrt',
      migrate: { service: 'web' },
      workloads: [
        {
          name: 'web',
          role: 'web',
          port: 3000,
          volumes: [
            {
              name: 'data',
              target: '/data',
              readOnly: false,
            },
          ],
        },
      ],
      bindings: [],
      localOnly: [],
    });
  });

  it('deploys from one digest', () => {
    const result = validateComposeDeployment(localFirst(), {
      stage: 'deploy',
      images: { web: digest('notes') },
    });
    expect(result.errors).toEqual([]);
    expect(result.declaration?.migrate.image).toBe(digest('notes'));
  });
});

describe('validateComposeDeployment: hostile and malformed input', () => {
  // The document is untrusted: nothing in it may make the validator throw.
  const unprintable = (): Record<string, unknown> => ({
    toString: 'not a function',
    valueOf: () => ({}),
  });
  const cyclic = (): unknown[] => {
    const list: unknown[] = [];
    list.push(list);
    return list;
  };

  it('reports values it cannot print instead of throwing', () => {
    const cases: Array<[(doc: Doc, value: unknown) => void, string]> = [
      [
        (doc, value) => (doc['x-happyvertical'].version = value),
        'version-unsupported',
      ],
      [
        (doc, value) => (doc['x-happyvertical'].preset = value),
        'preset-unknown',
      ],
      [
        (doc, value) => (doc['x-happyvertical'].domain = value),
        'domain-invalid',
      ],
      [
        (doc, value) => (doc.services.worker['x-happyvertical'].role = value),
        'role-unknown',
      ],
      [
        (doc, value) =>
          (doc.services.database['x-happyvertical'].binding = value),
        'binding-unknown',
      ],
      [
        (doc, value) => (doc.services.web.ports = [value]),
        'ingress-port-invalid',
      ],
      [
        (doc, value) =>
          (doc.services.web.ports = [{ target: 3000, protocol: value }]),
        'ingress-port-invalid',
      ],
      [
        (doc, value) =>
          (doc.services.web.ports = [{ target: 3000, mode: value }]),
        'host-network',
      ],
      [
        (doc, value) =>
          (doc.services.web.volumes = [{ type: value, target: '/data' }]),
        'volume-not-declared',
      ],
    ];
    for (const [mutate, code] of cases) {
      for (const value of [
        unprintable(),
        cyclic(),
        10n,
        Symbol('x'),
        () => 1,
      ]) {
        const result = check((doc) => mutate(doc, value));
        expect(result.errors.map((issue) => issue.code)).toEqual([code]);
        expect(result.declaration).toBeUndefined();
      }
    }
  });

  it('shortens very long values in messages', () => {
    const result = check((doc) => {
      doc['x-happyvertical'].preset = 'x'.repeat(5000);
    });
    expect(result.errors[0].message.length).toBeLessThan(200);
  });

  it('refuses a file with a YAML merge key left anywhere in it', () => {
    // Parsed without merge keys, `<<` hides whatever its anchor carries: a
    // privileged flag, a port's protocol, a volume's driver, whole services.
    const cases: Array<[(doc: Doc) => void, string]> = [
      [
        (doc) => (doc.services.worker['<<'] = { privileged: true }),
        'services.worker.<<',
      ],
      [
        (doc) =>
          (doc.services.web.ports = [
            { '<<': { protocol: 'udp', mode: 'host' }, target: 3000 },
          ]),
        'services.web.ports[0].<<',
      ],
      [
        (doc) => {
          doc.volumes.uploads = { '<<': { external: true } };
          doc.services.worker.volumes = ['uploads:/data'];
        },
        'volumes.uploads.<<',
      ],
      [
        (doc) => (doc.services['<<'] = { extra: doc.services.worker }),
        'services.<<',
      ],
      [
        (doc) => (doc['x-happyvertical']['<<'] = { domain: 'x.example.com' }),
        'x-happyvertical.<<',
      ],
      [
        (doc) => (doc.services.database['<<'] = { image: 'postgres' }),
        'services.database.<<',
      ],
      [(doc) => (doc['<<'] = { services: {} }), '<<'],
    ];
    for (const [mutate, path] of cases) {
      const result = check(mutate);
      expect(result.errors.map((issue) => issue.code)).toEqual([
        'merge-key-unresolved',
      ]);
      expect(result.errors[0].path).toBe(path);
      expect(result.errors[0].fix).toContain('merge keys enabled');
      expect(result.declaration).toBeUndefined();
    }
  });

  it('walks a document with cycles without looping', () => {
    const result = check((doc) => {
      doc.services.web.labels = doc.services;
      doc.loop = doc;
    });
    expect(result.errors).toEqual([]);
  });

  it('carries the name and a declared image only as literal text', () => {
    const literal = check((doc) => {
      doc.services.web.image = 'ghcr.io/acme/web:dev';
    }).declaration;
    expect(literal?.name).toBe('acme');
    expect(literal?.workloads[0].image).toBe('ghcr.io/acme/web:dev');
    expect(literal?.migrate.image).toBe('ghcr.io/acme/web:dev');

    const interpolated = check((doc) => {
      doc.name = '${APP:-acme}';
      doc.services.web.image = 'ghcr.io/${ORG}/web:dev';
    });
    expect(interpolated.errors).toEqual([]);
    expect(interpolated.declaration).not.toHaveProperty('name');
    expect(interpolated.declaration?.workloads[0]).not.toHaveProperty('image');
    expect(interpolated.declaration?.migrate).not.toHaveProperty('image');
    // At deploy an interpolated image is not a digest and is refused.
    expect(
      codes(
        (doc) => {
          doc.services.web.image = 'ghcr.io/${ORG}/web:dev';
        },
        { stage: 'deploy', images: { worker: digest('worker') } },
      ),
    ).toEqual(['image-not-digest']);
  });
});

describe('validateComposeDeployment: the contract block', () => {
  it('rejects a document that is not a mapping', () => {
    for (const value of [null, 'services:', [], 3]) {
      expect(
        validateComposeDeployment(value).errors.map((issue) => issue.code),
      ).toEqual(['document-invalid']);
    }
  });

  it('requires the top-level block', () => {
    expect(
      codes((doc) => {
        delete doc['x-happyvertical'];
      }),
    ).toEqual(['contract-missing']);
  });

  it('rejects a block that is not a mapping and unknown fields', () => {
    expect(
      codes((doc) => {
        doc['x-happyvertical'] = 'smrt';
      }),
    ).toEqual(['contract-invalid']);
    expect(
      codes((doc) => {
        doc['x-happyvertical'].tier = 'T2';
      }),
    ).toEqual(['contract-invalid']);
  });

  it('requires version 1 as a number', () => {
    for (const version of [undefined, 2, '1']) {
      expect(
        codes((doc) => {
          doc['x-happyvertical'].version = version;
        }),
      ).toEqual(['version-unsupported']);
    }
  });

  it('requires a known preset', () => {
    for (const preset of [undefined, 'smtr', 7]) {
      expect(
        codes((doc) => {
          doc['x-happyvertical'].preset = preset;
        }),
      ).toEqual(['preset-unknown']);
    }
  });

  it('requires domain to be a bare lowercase hostname', () => {
    for (const domain of [
      'https://app.example.com',
      'app.example.com:443',
      'app.example.com/path',
      'App.Example.com',
      'localhost',
      42,
    ]) {
      expect(
        codes((doc) => {
          doc['x-happyvertical'].domain = domain;
        }),
      ).toEqual(['domain-invalid']);
    }
  });

  it('requires migrate with a list command', () => {
    expect(
      codes((doc) => {
        delete doc['x-happyvertical'].migrate;
      }),
    ).toEqual(['migrate-missing']);
    for (const migrate of [
      'pnpm db:migrate',
      {},
      { command: 'pnpm db:migrate' },
      { command: [] },
      { command: ['pnpm'], image: 'x' },
      { command: ['pnpm'], service: 3 },
    ]) {
      expect(
        codes((doc) => {
          doc['x-happyvertical'].migrate = migrate;
        }),
      ).toEqual(['migrate-invalid']);
    }
  });

  it('requires migrate.service to be a web or worker service', () => {
    for (const service of ['migrate', 'database', 'missing']) {
      expect(
        codes((doc) => {
          doc['x-happyvertical'].migrate.service = service;
        }),
      ).toEqual(['migrate-service-not-role']);
    }
  });

  it('refuses a file that pulls in other files', () => {
    expect(
      codes((doc) => {
        doc.include = ['other.yaml'];
      }),
    ).toEqual(['not-self-contained']);
    expect(
      codes((doc) => {
        doc.services.web.extends = { file: 'base.yaml', service: 'web' };
      }),
    ).toEqual(['not-self-contained']);
  });
});

describe('validateComposeDeployment: service annotations', () => {
  it('requires services', () => {
    for (const services of [undefined, {}, []]) {
      expect(
        codes((doc) => {
          doc.services = services;
        }),
      ).toEqual(['services-missing']);
    }
  });

  it('rejects an empty service', () => {
    expect(
      codes((doc) => {
        doc.services.worker = null;
      }),
    ).toEqual(['service-invalid']);
  });

  it('rejects malformed annotations', () => {
    for (const annotation of [
      'web',
      {},
      { role: 'web', health: { path: '/' }, replicas: 2 },
    ]) {
      expect(
        codes((doc) => {
          doc.services.worker['x-happyvertical'] = annotation;
        }),
      ).toEqual(['annotation-invalid']);
    }
  });

  it('rejects a service that is both a role and a binding', () => {
    expect(
      codes((doc) => {
        doc.services.worker['x-happyvertical'].binding = 'ai';
      }),
    ).toEqual(['role-and-binding']);
  });

  it('rejects unknown roles and bindings', () => {
    expect(
      codes((doc) => {
        doc.services.worker['x-happyvertical'].role = 'cron';
      }),
    ).toEqual(['role-unknown']);
    expect(
      codes((doc) => {
        doc.services.database['x-happyvertical'].binding = 'mysql';
      }),
    ).toEqual(['binding-unknown']);
  });

  it('requires platform-safe names on annotated services only', () => {
    expect(
      codes((doc) => {
        doc.services.Web_App = doc.services.web;
        delete doc.services.web;
      }),
    ).toEqual(['service-name-invalid']);
    expect(
      check((doc) => {
        doc.services.Local_Tool = { image: 'adminer' };
      }).ok,
    ).toBe(true);
  });

  it('requires a health check on every role service', () => {
    expect(
      codes((doc) => {
        delete doc.services.web['x-happyvertical'].health;
      }),
    ).toEqual(['health-missing']);
  });

  it('rejects malformed health checks', () => {
    for (const health of [
      'ok',
      {},
      { path: '/health', command: ['true'] },
      { path: 'health' },
      { path: '/he alth' },
      { command: 'curl localhost' },
      { path: '/health', interval: '5s' },
    ]) {
      expect(
        codes((doc) => {
          doc.services.web['x-happyvertical'].health = health;
        }),
      ).toEqual(['health-invalid']);
    }
  });

  it('requires a command health check on workers', () => {
    expect(
      codes((doc) => {
        doc.services.worker['x-happyvertical'].health = { path: '/health' };
      }),
    ).toEqual(['worker-health-needs-command']);
  });

  it('accepts a command health check on the web service', () => {
    const result = check((doc) => {
      doc.services.web['x-happyvertical'].health = { command: ['true'] };
    });
    expect(result.declaration?.workloads[0].health).toEqual({
      command: ['true'],
    });
  });
});

describe('validateComposeDeployment: bindings', () => {
  it('requires every binding to keep a local image', () => {
    const result = check((doc) => {
      delete doc.services.database.image;
    });
    expect(result.errors.map((issue) => issue.code)).toEqual([
      'binding-no-local-image',
    ]);
    expect(result.errors[0].fix).toContain('complete working stack');
  });

  it('accepts a locally built stand-in', () => {
    expect(
      check((doc) => {
        delete doc.services.database.image;
        doc.services.database.build = './dev/postgres';
      }).ok,
    ).toBe(true);
  });

  it('rejects health on a binding annotation', () => {
    expect(
      codes((doc) => {
        doc.services.database['x-happyvertical'].health = {
          command: ['pg_isready'],
        };
      }),
    ).toEqual(['binding-with-health']);
  });

  it('binds each platform service once', () => {
    expect(
      codes((doc) => {
        doc.services.replica = {
          image: 'postgres:18-alpine',
          'x-happyvertical': { binding: 'postgres' },
        };
      }),
    ).toEqual(['binding-duplicate']);
  });

  it('accepts every version 1 binding kind', () => {
    const result = check((doc) => {
      doc.services.storage = {
        image: 'minio/minio',
        'x-happyvertical': { binding: 'bucket' },
      };
      doc.services.mail = {
        image: 'axllent/mailpit',
        'x-happyvertical': { binding: 'email' },
      };
      doc.services.models = {
        image: 'ollama/ollama',
        'x-happyvertical': { binding: 'ai' },
      };
    });
    expect(result.declaration?.bindings).toEqual([
      { name: 'database', kind: 'postgres' },
      { name: 'storage', kind: 'bucket' },
      { name: 'mail', kind: 'email' },
      { name: 'models', kind: 'ai' },
    ]);
  });

  it('does not apply the platform subset to bindings or local-only services', () => {
    expect(
      check((doc) => {
        doc.services.database.privileged = true;
        doc.services.database.volumes = ['./data:/var/lib/postgresql'];
        doc.services.migrate.network_mode = 'host';
      }).ok,
    ).toBe(true);
  });
});

describe('validateComposeDeployment: one web service, one ingress port', () => {
  it('requires exactly one web service', () => {
    expect(
      codes((doc) => {
        doc.services.web['x-happyvertical'] = {
          role: 'worker',
          health: { command: ['true'] },
        };
        delete doc.services.web.ports;
      }),
    ).toEqual(['web-service-count']);
    expect(
      codes((doc) => {
        doc.services.admin = structuredClone(doc.services.web);
      }),
    ).toEqual(['web-service-count']);
  });

  it('requires the web service to publish exactly one port', () => {
    expect(
      codes((doc) => {
        delete doc.services.web.ports;
      }),
    ).toEqual(['ingress-port-count']);
    expect(
      codes((doc) => {
        doc.services.web.ports = ['3000:3000', '9229:9229'];
      }),
    ).toEqual(['ingress-port-count']);
  });

  it('counts one container port published twice as one', () => {
    expect(
      check((doc) => {
        doc.services.web.ports = ['3000:3000', '127.0.0.1:8080:3000'];
      }).declaration?.workloads[0].port,
    ).toBe(3000);
  });

  it('rejects ports the platform cannot read', () => {
    for (const ports of [
      ['3000-3005:3000-3005'],
      ['3000:3000/udp'],
      ['3000:${APP_PORT}'],
      [{ target: 'web', published: 80 }],
      [{ target: true }],
      [{ target: [3000] }],
      [{ target: '3000-3005' }],
      [{ target: 53, protocol: 'udp' }],
      [70000],
      [true],
      '3000:3000',
    ]) {
      expect(
        codes((doc) => {
          doc.services.web.ports = ports;
        }),
      ).toEqual(['ingress-port-invalid']);
    }
  });

  it('rejects a worker that publishes anything, without port advice', () => {
    for (const ports of [
      ['9000:9000'],
      ['9000-9005'],
      [{ mode: 'host' }],
      'x',
    ]) {
      expect(
        codes((doc) => {
          doc.services.worker.ports = ports;
        }),
      ).toEqual(['worker-publishes-port']);
    }
    expect(
      check((doc) => {
        doc.services.worker.ports = [];
      }).ok,
    ).toBe(true);
  });

  it('accepts long-syntax ports with a digit-string target or ingress mode', () => {
    expect(
      check((doc) => {
        doc.services.web.ports = [{ target: '8080', mode: 'ingress' }];
      }).declaration?.workloads[0].port,
    ).toBe(8080);
  });
});

describe('validateComposeDeployment: the supported platform subset', () => {
  it('requires a role service to be runnable', () => {
    expect(
      codes((doc) => {
        delete doc.services.worker.build;
      }),
    ).toEqual(['service-no-image']);
  });

  it('allows build and tags at the declare stage', () => {
    expect(
      check((doc) => {
        doc.services.web.image = 'ghcr.io/acme/web:latest';
      }).ok,
    ).toBe(true);
  });

  it('deploys digests only: a build-only service needs a supplied digest', () => {
    const result = check(undefined, {
      stage: 'deploy',
      images: { web: digest('web') },
    });
    expect(result.errors.map((issue) => issue.code)).toEqual([
      'image-not-digest',
    ]);
    expect(result.errors[0].service).toBe('worker');
    expect(result.errors[0].message).toContain('never runs `build:`');
    expect(result.declaration).toBeUndefined();
  });

  it('deploys digests only: tags are refused', () => {
    for (const image of [
      'ghcr.io/acme/web:1.2.3',
      'ghcr.io/acme/web:latest',
      'ghcr.io/acme/web@sha256:abc',
    ]) {
      expect(
        codes(() => {}, {
          stage: 'deploy',
          images: { web: image, worker: digest('worker') },
        }),
      ).toEqual(['image-not-digest']);
    }
  });

  it('reads supplied digests by own key, whatever a service is called', () => {
    const result = check(
      (doc) => {
        doc.services.constructor = doc.services.worker;
        delete doc.services.worker;
      },
      { stage: 'deploy', images: { web: digest('web') } },
    );
    expect(
      result.errors.map((issue) => `${issue.code}:${issue.service}`),
    ).toEqual(['image-not-digest:constructor']);
    const declared = check((doc) => {
      doc.services.constructor = doc.services.worker;
      delete doc.services.worker;
    });
    expect(declared.declaration?.workloads[1]).not.toHaveProperty('image');
  });

  it('refuses a digest for a service that is not deployed', () => {
    expect(
      codes(() => {}, {
        stage: 'deploy',
        images: { ...deploy.images, database: digest('postgres') },
      }),
    ).toEqual(['image-for-unknown-service']);
  });

  it('refuses privileged containers, however the boolean is spelled', () => {
    // Compose honours YAML 1.1 booleans; a YAML 1.2 parser yields strings.
    for (const privileged of [true, 'true', 'yes', 'on', 'Y', 1]) {
      expect(
        codes((doc) => {
          doc.services.worker.privileged = privileged;
        }),
      ).toEqual(['privileged']);
    }
    for (const privileged of [false, null, undefined]) {
      expect(
        check((doc) => {
          doc.services.worker.privileged = privileged;
        }).ok,
      ).toBe(true);
    }
  });

  it('refuses host networking', () => {
    expect(
      codes((doc) => {
        doc.services.worker.network_mode = 'host';
      }),
    ).toEqual(['host-network']);
    expect(
      codes((doc) => {
        doc.services.web.ports = [
          { target: 3000, published: 3000, mode: 'host' },
        ];
      }),
    ).toEqual(['host-network']);
  });

  it('refuses mounts that are not declared data volumes', () => {
    for (const volumes of [
      ['./src:/app/src'],
      ['/var/run/docker.sock:/var/run/docker.sock'],
      ['~/.aws:/root/.aws:ro'],
      ['C:\\data:/data'],
      ['C:/data:/data'],
      ['..\\src:/app/src'],
      ['${DATA_DIR}:/data'],
      ['/data'],
      ['uploads:/data'],
      [{ type: 'bind', source: './src', target: '/app/src' }],
      [{ type: 'volume', target: '/data' }],
      [{ type: 'volume', source: 'postgres-data' }],
      [42],
      'postgres-data:/data',
    ]) {
      expect(
        codes((doc) => {
          doc.services.worker.volumes = volumes;
        }),
      ).toEqual(['volume-not-declared']);
    }
    expect(
      codes((doc) => {
        doc.services.worker.volumes_from = ['web'];
      }),
    ).toEqual(['volume-not-declared']);
  });

  it('refuses declared volumes that point somewhere else', () => {
    for (const definition of [
      { external: true },
      { driver: 'nfs' },
      { driver_opts: { type: 'none', o: 'bind', device: '/srv/data' } },
    ]) {
      expect(
        codes((doc) => {
          doc.volumes.uploads = definition;
          doc.services.worker.volumes = ['uploads:/data'];
        }),
      ).toEqual(['volume-not-plain']);
    }
  });

  it('refuses commands that Compose and the platform would read differently', () => {
    for (const command of [
      'sh -c "node build"',
      'node build && echo done',
      ['node', 3],
      { run: 'node' },
    ]) {
      expect(
        codes((doc) => {
          doc.services.web.command = command;
        }),
      ).toEqual(['command-not-list']);
    }
    expect(
      codes((doc) => {
        doc.services.web.entrypoint = "sh -c 'exec node'";
      }),
    ).toEqual(['command-not-list']);
  });

  it('refuses variables in anything the declaration carries', () => {
    // Compose substitutes `$VAR` everywhere, extension fields included; a
    // reader of the file as written would run something else.
    const cases: Array<(doc: Doc) => void> = [
      (doc) => (doc.services.web.command = 'node $ENTRY'),
      (doc) => (doc.services.web.command = ['node', '${ENTRY}']),
      (doc) => (doc.services.web.command = ['sh', '-c', 'echo $$HOME']),
      (doc) => (doc.services.web.entrypoint = ['${INIT:-tini}', '--']),
      (doc) => (doc['x-happyvertical'].migrate.command = ['pnpm', '$TASK']),
      (doc) => (doc.services.web['x-happyvertical'].health.path = '/${P}'),
      (doc) =>
        (doc.services.worker['x-happyvertical'].health.command = [
          'check',
          '$MODE',
        ]),
      (doc) => {
        doc.volumes.uploads = null;
        doc.services.worker.volumes = ['uploads:/data/${TENANT}'];
      },
    ];
    for (const mutate of cases) {
      const result = check(mutate);
      expect(result.errors.map((issue) => issue.code)).toEqual([
        'interpolated-value',
      ]);
      expect(result.declaration).toBeUndefined();
    }
  });

  it('keeps the Compose meaning of entrypoint and command', () => {
    const result = check((doc) => {
      doc.services.web.entrypoint = ['tini', '--'];
      doc.services.worker.entrypoint = [];
      delete doc.services.worker.command;
    });
    const [web, worker] = result.declaration?.workloads ?? [];
    expect(web.entrypoint).toEqual(['tini', '--']);
    // An empty entrypoint discards the image's own; it is not "unset".
    expect(worker.entrypoint).toEqual([]);
    expect(worker).not.toHaveProperty('command');
    // Unset means the image's entrypoint runs.
    expect(check().declaration?.workloads[0]).not.toHaveProperty('entrypoint');
  });
});

describe('validateComposeDeployment: reporting', () => {
  it('reports every problem in one pass with a path, a message and a fix', () => {
    const result = check((doc) => {
      doc['x-happyvertical'].version = 2;
      doc.services.worker.privileged = true;
      delete doc.services.database.image;
    });
    expect(result.ok).toBe(false);
    expect(result.declaration).toBeUndefined();
    expect(result.errors.map((issue) => issue.code).sort()).toEqual([
      'binding-no-local-image',
      'privileged',
      'version-unsupported',
    ]);
    for (const issue of result.errors) {
      expect(issue.severity).toBe('error');
      expect(issue.path.length).toBeGreaterThan(0);
      expect(issue.message.length).toBeGreaterThan(20);
      expect(issue.fix.length).toBeGreaterThan(10);
    }
  });

  it('formats a failing report for a terminal', () => {
    const report = formatComposeDeploymentReport(
      check((doc) => {
        doc.services.worker.privileged = true;
      }),
    );
    expect(report).toContain('The deployment declaration has 1 problem.');
    expect(report).toContain('1. services.worker.privileged: ');
    expect(report).toContain('   Fix: Remove the `privileged` line.');
    expect(report).toContain('Runs only on your machine');
  });

  it('formats a passing report with what will be deployed', () => {
    const report = formatComposeDeploymentReport(check());
    expect(report).toContain('The deployment declaration is valid.');
    expect(report).toContain('Runs: web (web, port 3000), worker (worker)');
    expect(report).toContain(
      'Migration: pnpm exec smrt db:migrate (in the web image)',
    );
    expect(report).toContain('Platform services: postgres (local: database)');
    expect(report).toContain('Domain: app.example.com');
    expect(report).toContain(
      'Runs only on your machine (the platform will not run it): migrate',
    );
  });
});

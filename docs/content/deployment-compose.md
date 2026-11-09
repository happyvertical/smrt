---
title: Compose deployment contract
---

# Compose deployment contract

An SMRT application declares how it is deployed in its own repository, in the
Compose file it already uses to run locally. The declaration is a small set of
`x-happyvertical` extension fields. Compose ignores keys that start with `x-`,
so one file does three jobs:

- `docker compose up` runs the complete stack on a laptop;
- the same file runs the stack on a self-hosted box, or feeds the
  [`smrt-app` chart](https://github.com/happyvertical/smrt/blob/main/charts/smrt-app/README.md)
  for a self-hosted Kubernetes release;
- a hosting platform reads the annotations, deploys the application's own
  services from image digests, and provides its own PostgreSQL, bucket, mail
  or AI service in place of each local stand-in.

The contract is versioned. This page describes version 1.

| Artifact | Where |
| --- | --- |
| JSON Schema | [`packages/config/schemas/x-happyvertical.v1.schema.json`](https://github.com/happyvertical/smrt/blob/main/packages/config/schemas/x-happyvertical.v1.schema.json), published as `@happyvertical/smrt-config/schemas/x-happyvertical.v1.schema.json` |
| Validator and renderer | `@happyvertical/smrt-config/deployment` |
| Commands | `smrt deploy:check`, `smrt deploy:chart-values` |
| Annotated example | [`packages/template-sveltekit/template/compose.yaml`](https://github.com/happyvertical/smrt/blob/main/packages/template-sveltekit/template/compose.yaml) |

## The declaration

```yaml
x-happyvertical:
  version: 1
  preset: smrt
  domain: app.example.com
  migrate:
    command: ["pnpm", "exec", "smrt", "db:migrate"]

services:
  web:
    build: .
    command: node build
    ports:
      - "3000:3000"
    x-happyvertical:
      role: web
      health:
        path: /api/_runtime/health

  worker:
    build: .
    command: pnpm exec smrt app worker task
    x-happyvertical:
      role: worker
      health:
        command: ["pnpm", "exec", "smrt", "app", "doctor"]

  database:
    image: postgres:18-alpine
    volumes:
      - postgres-data:/var/lib/postgresql
    x-happyvertical:
      binding: postgres

volumes:
  postgres-data:
```

### Top-level block

| Field | Required | Meaning |
| --- | --- | --- |
| `version` | yes | The contract version, the number `1`. |
| `preset` | yes | Which platform preset fills in the rest of the deployment. Version 1 knows `smrt`. |
| `domain` | no | The hostname the application wants to be served on: lowercase, no scheme, port or path. Whether a platform grants it is the platform's decision. |
| `migrate.command` | yes | The command that prepares the database before a release serves traffic, as a list with one argument per item. |
| `migrate.service` | no | The web or worker service whose image runs the migration. Defaults to the web service. |

### Service block

Every service is one of three things.

| Annotation | What it is | What a platform does with it |
| --- | --- | --- |
| `role: web` with `health` | The one service visitors reach. | Deploys it from an image digest and routes traffic to its port. |
| `role: worker` with `health` | Something the application runs in the background. | Deploys it from an image digest. It receives no traffic. |
| `binding: postgres`, `bucket`, `email` or `ai` | A local stand-in for a service the platform provides. | Does not run the container. It provides its own service and gives the application the credentials. |
| no annotation | A local helper, such as a one-shot migration job or a database admin tool. | Nothing. It runs only on your machine, and the validator lists it so that is never a surprise. |

`health` says how to tell that a service is ready. It takes exactly one of:

- `path`: an HTTP path on the web service's port that answers with a 2xx
  status. Web services only.
- `command`: a command list run inside the container that exits 0. Workers
  must use this form.

A binding takes no `health`: the platform runs its own service. A Compose
`healthcheck:` on the local stand-in is still useful locally and is left alone.

Environment values written in the Compose file are local values. Version 1
does not carry them into a deployment: bindings supply their own connection
settings, and everything else is configured where the application is hosted.

## The supported platform subset

A platform runs the `role` services, so only those are held to the subset
below. Binding stand-ins and unannotated local helpers may use anything
Compose supports.

| Rule | Why |
| --- | --- |
| Images are deployed by digest. `build:` is never run. | CI builds and pushes once; the platform deploys exactly what was tested. A tag can move after it was tested. |
| Only declared data volumes. | A volume must be a named volume under top-level `volumes:`. Bind mounts, unnamed volumes, `volumes_from`, and volumes that are `external` or use `driver_opts` read from a machine the file does not describe. `tmpfs` scratch space is allowed and holds no data. |
| No `privileged`. | It gives the container control of the machine it runs on. Any value other than `false` is refused. |
| No host networking. | `network_mode: host` and `mode: host` port publishing bind to the machine's own network. Services reach each other by service name. |
| One ingress port. | Exactly one service has `role: web`, and it publishes exactly one fixed TCP container port. Workers publish none. |
| Every `binding` keeps a local image. | The file must stay a complete working stack where no platform is providing that service. |
| One file. | Top-level `include` and `extends` on a role service are refused: the platform reads this file and nothing else. |
| Commands the platform can run as written. | `command` and `entrypoint` on a role service are a list, or a plain string of space-separated words. Quoting, variables and shell operators are split differently by Compose and by a container runtime. |

Only what the tables above name is part of the declaration. Every other
Compose setting on a role service (`environment`, `depends_on`, `restart`,
`deploy`, `user`, `cap_add`, `devices`, `pid` and the rest) is neither checked
nor carried: it keeps working locally and a platform does not see it.

Version 1 binds each platform service at most once, and service names that
carry an annotation must be lowercase letters, digits and hyphens, starting
with a letter, at most 31 characters.

### Two stages

The same file is checked at two moments.

- **`declare`**: the file as it sits in the repository. Services may be built
  locally (`build:`) or use tags, so the stack is convenient to develop on.
- **`deploy`**: a release. Every web and worker service must resolve to an
  image digest (`registry/name@sha256:` and 64 hex characters), either written
  in the file or supplied with the release. A service with only `build:` and
  no supplied digest is refused, as is any tag.

## Checking a file

```bash
pnpm exec smrt deploy:check
```

With no argument the command reads the first of `compose.yaml`,
`compose.yml`, `docker-compose.yaml` and `docker-compose.yml` in the current
directory. It prints what would be deployed, or each problem with its location
and what to change, and exits 1 when there is a problem:

```text
The deployment declaration has 1 problem.

1. services.worker.privileged: Service `worker` asks for privileged mode, which gives the container control of the machine it runs on.
   Fix: Remove the `privileged` line. The platform never runs privileged containers.

Runs only on your machine (the platform will not run it): migrate
```

Check a release by supplying the digests CI pushed:

```bash
pnpm exec smrt deploy:check \
  --image web=ghcr.io/acme/app@sha256:<digest> \
  --image worker=ghcr.io/acme/app@sha256:<digest>
```

`--deploy` checks the deploy stage using only the images written in the file,
and `--json` prints the result, including the resolved declaration, for
tooling.

From code, parse the YAML yourself (with merge keys enabled, as Compose does)
and pass the document in:

```ts
import { validateComposeDeployment } from '@happyvertical/smrt-config/deployment';

const result = validateComposeDeployment(document, {
  stage: 'deploy',
  images: { web: webDigest, worker: workerDigest },
});
if (!result.ok) {
  for (const issue of result.errors) console.error(issue.path, issue.message, issue.fix);
}
```

`result.declaration` is the resolved declaration: preset, domain, the
migration, each workload with its role, image, command, port and health check,
and each binding. A platform composes its own resources from that object and
its own entitlements; it does not re-read the Compose file.

The JSON Schema checks the shape of the annotations and is enough for a tool
that only needs to know a file is a well-formed declaration. The rules in the
subset table span several services and are checked by the validator only.

## The chart is the self-host rendering

The [`smrt-app` chart](https://github.com/happyvertical/smrt/blob/main/charts/smrt-app/README.md)
renders the `smrt-release-v1` release contract described in
[Maintenance-window application deployment](./deployment.md): workloads
classified as writers, a retained migration Job that runs before the target
starts, a maintenance responder, and configuration from named immutable
Secrets. It is the rendering of this declaration for a cluster you run
yourself. A hosting platform's `smrt` preset is the other rendering: it takes
the same declaration and is the runner for the same release contract. Hosting
on a platform and hosting on your own cluster therefore start from one file,
and an application can move between them without rewriting how it is
described.

The declaration says what the application is. A chart release also needs what
the environment owns, and none of that belongs in the Compose file: the
release identity and phase, Secret references for each binding, resources and
replicas, the maintenance responder image, and the ingress class. Supply those
as a JSON inputs file and render the values:

```bash
pnpm exec smrt deploy:chart-values --inputs self-host.json \
  --image web=ghcr.io/acme/app@sha256:<digest> \
  --image worker=ghcr.io/acme/app@sha256:<digest> > values.json
```

The inputs file:

```json
{
  "release": { "id": "release-001", "phase": "maintenance", "sequence": 0, "attempt": 1 },
  "app": { "name": "acme", "environment": "production" },
  "bindings": {
    "postgres": {
      "runtime": { "secretName": "app-runtime-v1", "secretKey": "uri" },
      "migration": { "secretName": "app-migration-v1", "secretKey": "uri" }
    }
  },
  "env": [
    { "name": "SESSION_SECRET", "secretName": "app-config-v1", "secretKey": "session-secret" }
  ],
  "defaults": {
    "resources": {
      "requests": { "cpu": "100m", "memory": "128Mi" },
      "limits": { "cpu": "1", "memory": "512Mi" }
    },
    "terminationGracePeriodSeconds": 90
  },
  "workloads": { "web": { "replicas": 2 }, "worker": { "role": "task" } },
  "maintenance": {
    "image": "docker.io/library/nginx@sha256:<digest>",
    "command": ["nginx", "-g", "daemon off;"],
    "port": 8080,
    "http": { "path": "/", "status": 503, "body": "Maintenance" }
  },
  "ingress": { "className": "nginx" }
}
```

`release`, `app.environment`, `bindings`, `defaults`, `maintenance` and
`ingress.className` are required. `app.name` defaults to the Compose file's
top-level `name:`, and `ingress.host` to the declared `domain`. Add
`currentImages` (digest per service) to render the running release as
`current`; without it the values describe a first install. `env` entries may
carry a `services` list to limit a variable to some workloads. `maintenance`
and any further `ingress` fields are passed to the chart unchanged.

| Declaration | Chart values |
| --- | --- |
| `role: web` service | The one `web` workload, with `port`, `service.port` and an HTTP or exec `readinessProbe` from `health`. |
| `role: worker` service | A `background` workload (the singleton runner) with an exec `readinessProbe`. The inputs may select `task` or `schedule` per service. |
| `command` and `entrypoint` | The workload `command`. The chart starts every workload with an explicit command. |
| `migrate` | `target.migration`: the image of `migrate.service`, the declared command, and the `smrt-release-v1` guard. |
| `binding: postgres` | `bindings.database` and a `DATABASE_URL` Secret reference on every workload; the migration gets its own migration-only Secret. |
| `binding: bucket` | An entry in `bindings.privateBuckets` named after the service. |
| `binding: email`, `binding: ai` | Nothing chart-specific. Supply their settings as Secret-backed `env` entries in the inputs. |
| `domain` | `ingress.host`, unless the inputs set one. |

`deploy:chart-values` refuses to guess: a missing digest, command, hostname or
Secret reference is reported, and a role service that mounts a data volume is
refused because the chart binds existing databases and buckets and creates no
persistent volumes. The rendered values document is the starting point for the
runner described in the deployment guide; rendering it does not deploy
anything.

To keep the two from drifting, the chart's `starter` fixture is not written by
hand. `charts/smrt-app/fixtures/starter.json` is generated from the annotated
template Compose file, and the repository's tests fail when either changes
without the other:

```bash
node scripts/compose-contract-fixture.mjs --write
```

## Compatibility

Version 1 changes only by addition: a new binding kind, a new preset, or a new
optional field. A file that is valid today stays valid. Anything that would
change the meaning of an existing field is version 2, with a new schema file
beside this one.

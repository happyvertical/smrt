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
- a hosting platform that implements the contract reads the annotations,
  deploys the application's own services from image digests, and provides its
  own PostgreSQL, bucket, mail or AI service in place of each local stand-in.

This page specifies the contract and what this repository ships for it: the
schema, the validator, and the chart rendering. A hosting platform is a
separate system; what one does with a declaration is described here as what
the contract asks of it, not as a description of any particular platform.

The contract is versioned. This page describes version 1.

| Artifact | Where |
| --- | --- |
| JSON Schema | [`packages/config/schemas/x-happyvertical.v1.schema.json`](https://github.com/happyvertical/smrt/blob/main/packages/config/schemas/x-happyvertical.v1.schema.json), published as `@happyvertical/smrt-config/schemas/x-happyvertical.v1.schema.json` |
| Validator and renderer | `@happyvertical/smrt-config/deployment` |
| Commands | `smrt deploy:check`, `smrt deploy:chart-values` |
| Canonical example | [`packages/template-sveltekit/template/compose.yaml`](https://github.com/happyvertical/smrt/blob/main/packages/template-sveltekit/template/compose.yaml) |

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
    entrypoint: ["docker-entrypoint.sh"]
    command: node build
    ports:
      - "3000:3000"
    x-happyvertical:
      role: web
      health:
        path: /api/_runtime/health

  worker:
    build: .
    entrypoint: ["docker-entrypoint.sh"]
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

Under the `smrt` preset a release follows the `smrt-release-v1` contract in
[Maintenance-window application deployment](./deployment.md). That places an
obligation on `migrate.command`: it has to be the application's wrapper that
rechecks writer quiescence, takes the migration advisory lock and uses the
durable phase API. Declaring a command does not make it one. The template's
`smrt db:migrate` runs the migrations and is not yet such a wrapper, which is
one of the adoption gaps the deployment guide lists.

### Service block

Every service is one of three things.

| Annotation | What it is | What the contract asks of a platform |
| --- | --- | --- |
| `role: web` with `health` | The one service visitors reach. | Deploy it from an image digest and route traffic to its port. |
| `role: worker` with `health` | Something the application runs in the background. | Deploy it from an image digest. It receives no traffic. |
| `binding: postgres`, `bucket`, `email` or `ai` | A local stand-in for a service the platform provides. | Do not run the container. Provide the service and give the application its credentials. |
| no annotation | A local helper, such as a one-shot migration job or a database admin tool. | Nothing. It runs only on your machine, and the validator lists it so that is never a surprise. |

`health` says how to tell that a service is ready. It takes exactly one of:

- `path`: an HTTP path on the web service's port that answers with a 2xx
  status. Web services only.
- `command`: a command list run inside the container that exits 0. Workers
  must use this form.

A binding takes no `health`: its container is not what gets deployed. A
Compose `healthcheck:` on the local stand-in is still useful locally and is
left alone.

`role: worker` says only that the service runs in the background. Whether a
worker is a singleton or may be scaled, how many replicas run, and what
resources they get are not part of version 1; whoever hosts the application
decides them (for the chart, in the inputs file below).

Environment values written in the Compose file are local values. Version 1
does not carry them into a deployment: bindings supply their own connection
settings, and everything else is configured where the application is hosted.

## Two shapes

Version 1 is written for two application shapes.

**Web, workers and platform services.** The canonical example is the scaffold
template's
[`compose.yaml`](https://github.com/happyvertical/smrt/blob/main/packages/template-sveltekit/template/compose.yaml):
a web service, a task worker and a schedule worker built from one image, a
one-shot local migration job, and PostgreSQL as a `binding`. This is the shape
the `smrt-app` chart renders, and the chart's `starter` fixture is generated
from that file.

**Local-first, one process.** An application that keeps its data in SQLite and
runs as a single process, such as one started from `smrt-start`, declares one
`role: web` service with a declared data volume, no worker and no binding:

```yaml
x-happyvertical:
  version: 1
  preset: smrt
  migrate:
    command: ["pnpm", "exec", "smrt", "app", "migrate"]

services:
  web:
    build: .
    entrypoint: ["docker-entrypoint.sh"]
    command: ["pnpm", "exec", "smrt", "app", "start"]
    ports:
      - "3000:3000"
    volumes:
      - data:/home/node/.local/share/notes
    x-happyvertical:
      role: web
      health:
        path: /api/_runtime/health

volumes:
  data:
```

The data volume is what makes this shape storable: the declaration carries the
volume's name and mount path, and a platform that hosts it gives the one
replica a persistent volume there. SQLite is storage the application owns, so
it is a declared volume and not a `binding`. The `smrt-app` chart does not
render this shape: it binds an existing PostgreSQL database and creates no
persistent volumes, and `smrt deploy:chart-values` says so. The commands and
the mount path above are illustrative; `smrt-start` does not ship a Compose
file today.

## The supported platform subset

A platform runs the `role` services, so only those are held to the subset
below. Binding stand-ins and unannotated local helpers may use anything
Compose supports.

| Rule | Why |
| --- | --- |
| Images are deployed by digest. `build:` is never run. | CI builds and pushes once; the platform deploys exactly what was tested. A tag can move after it was tested. |
| Only declared data volumes. | A volume must be a named volume under top-level `volumes:`. Bind mounts, unnamed volumes, `volumes_from`, and volumes that are `external` or use `driver_opts` read from a machine the file does not describe. `tmpfs` scratch space is allowed and holds no data. |
| No `privileged`. | It gives the container control of the machine it runs on. Any value other than `false` is refused. |
| No host networking. | `network_mode: host`, and a published port with a `mode` other than `ingress`, bind to the network of the machine the container runs on. Services reach each other by service name. |
| One ingress port. | Exactly one service has `role: web`, and it publishes exactly one fixed TCP container port. Workers publish none. |
| Every `binding` keeps a local image. | The file must stay a complete working stack where no platform is providing that service. |
| One file, read as written. | Top-level `include` and `extends` on a role service are refused, and so is an unresolved YAML merge key (`<<`): each service must be complete in this file. |
| No variables in what is carried. | Compose replaces `$VAR` and `${VAR}` in every string before it runs the stack, including inside `x-happyvertical`. A reader of the file as written would run something else, so `$` is refused in `command`, `entrypoint`, `migrate.command`, `health` and volume mount paths. The published side of a port (`"${WEB_PORT:-3000}:3000"`) and anything outside the declaration may use variables. |
| Commands that mean one thing. | `command` and `entrypoint` on a role service are a list, or a plain string of space-separated words. Quoting and shell operators are split differently by Compose and by a container runtime. |

`entrypoint` and `command` keep their Compose meaning in the declaration. With
no `entrypoint`, the image's own entrypoint runs and `command` is its
arguments. With `entrypoint` set, it replaces the image's, and `entrypoint: []`
discards it.

Only what the tables above name is part of the declaration. Every other
Compose setting on a role service (`environment`, `depends_on`, `restart`,
`deploy`, `networks`, `user`, `cap_add`, `devices`, `pid` and the rest) is
neither checked nor carried: it keeps working locally and a platform does not
see it.

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

1. services.worker.privileged: Service `worker` sets `privileged`. Privileged mode gives a container control of the machine it runs on, and Compose accepts more spellings of "yes" than can be told apart here.
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

From code, parse the YAML yourself, with merge keys enabled as Compose does,
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

The validator treats the document as untrusted: whatever its shape, it returns
a result and does not throw. `result.declaration` is present only when there
are no errors. It is the resolved declaration: preset, domain, the migration,
each workload with its role, image, entrypoint, command, port, health check
and volumes, and each binding. A consumer should work from that object and
not re-read the Compose file, because nothing outside it has been checked.

The JSON Schema checks the shape of the annotations and is enough for a tool
that only needs to know a file is a well-formed declaration. The rules in the
subset table span several services and are checked by the validator only.

## The chart is the self-host rendering

The [`smrt-app` chart](https://github.com/happyvertical/smrt/blob/main/charts/smrt-app/README.md)
renders the `smrt-release-v1` release contract described in
[Maintenance-window application deployment](./deployment.md): workloads
classified as writers, a retained migration Job that runs before the target
starts, a maintenance responder, and configuration from named immutable
Secrets. `smrt deploy:chart-values` renders a declaration into values for that
chart, for a cluster you run yourself. A hosting platform's `smrt` preset is
intended to be the runner for the same release contract, starting from the
same declaration, so that an application is described once whether it is
hosted or self-hosted. The two are separate implementations: each decides for
itself what the declaration leaves open, such as replicas and resources.

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
  "workloads": {
    "web": { "replicas": 2 },
    "worker": { "role": "task", "readiness": { "periodSeconds": 60, "timeoutSeconds": 30 } }
  },
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
top-level `name:`, and `ingress.host` to the declared `domain`. The inputs are
checked before anything is rendered:

- `bindings.postgres.runtime` and `.migration` must name different Secrets,
  and no `env` entry may read the migration Secret;
- `env` entries may carry a `services` list to limit a variable to some
  workloads, and `workloads` is keyed by service name. Both may only name web
  and worker services the declaration has, so a misspelled name is an error
  and not a silently dropped setting;
- a worker's `role` is `background` (the default, a singleton), `schedule`
  (a singleton) or `task` (may have `replicas` above 1);
- `readiness` sets the timing of the probe rendered from `health`. Without it
  the Kubernetes defaults apply, including a one-second timeout, which a
  command that starts a CLI will not meet.

`maintenance` and any further `ingress` fields are passed to the chart
unchanged, and the chart's own schema checks them when Helm renders.

`current` describes the release that is running now. It is never worked out
from the new declaration, because the running release can differ from it in
more than its image digests. Leave it out for a first install. For a later
release, pass the previous values document's `target` block as `current`
unchanged; the release runner in the deployment guide does this itself and
refuses a plan that does not preserve the running runtime.

| Declaration | Chart values |
| --- | --- |
| `role: web` service | The one `web` workload, with `port`, `service.port` and an HTTP or exec `readinessProbe` from `health`. |
| `role: worker` service | A `background` workload (the singleton runner) with an exec `readinessProbe`. The inputs may select `task` or `schedule` per service. |
| `entrypoint` and `command` | The workload `command`: the entrypoint followed by the command. |
| `migrate` | `target.migration`: the image of `migrate.service`, the declared command, and the `smrt-release-v1` guard declaration. |
| `binding: postgres` | `bindings.database` and a `DATABASE_URL` Secret reference on every workload; the migration gets its own migration-only Secret. |
| `binding: bucket` | An entry in `bindings.privateBuckets` named after the service. |
| `binding: email`, `binding: ai` | Nothing chart-specific. Supply their settings as Secret-backed `env` entries in the inputs. |
| `domain` | `ingress.host`, unless the inputs set one. |

The chart starts a workload with exactly the command it is given and never
runs the image's own entrypoint. Compose runs the image's entrypoint with
`command` as its arguments. So that both start the same process, a service
rendered for the chart must set `entrypoint` in the Compose file: the image's
entrypoint written out, as the template does, or `entrypoint: []` when
`command` is complete on its own. `smrt deploy:chart-values` refuses a service
that leaves its entrypoint to the image.

`deploy:chart-values` refuses to guess: a missing digest, entrypoint,
hostname or Secret reference is reported, and a role service that mounts a
data volume is refused because the chart binds existing databases and buckets
and creates no persistent volumes. The rendered values document is the
starting point for the runner described in the deployment guide. Rendering it
does not deploy anything, and the `guard` it carries declares a capability
that `migrate.command` still has to implement.

So that the chart and the contract do not drift apart unnoticed, the chart's
`starter` fixture is not written by hand.
`charts/smrt-app/fixtures/starter.json` is generated from the annotated
template Compose file, and the repository's tests fail when the template, the
renderer or the fixture changes without the others:

```bash
node scripts/compose-contract-fixture.mjs --write
```

## Compatibility

Version 1 changes only by addition: a new binding kind, a new preset, or a new
optional field. A file that is valid today stays valid. Anything that would
change the meaning of an existing field is version 2, with a new schema file
beside this one.

#!/usr/bin/env node
// Regenerates charts/smrt-app/fixtures/starter.json from the annotated
// starter Compose file (packages/template-sveltekit/template/compose.yaml).
//
// The chart is the self-host rendering of the compose deployment contract, so
// its starter fixture is generated, never edited by hand:
//
//   node scripts/compose-contract-fixture.mjs --write   regenerate the fixture
//   node scripts/compose-contract-fixture.mjs           fail when it is stale
//
// Needs packages/config built (`pnpm turbo run build --filter=@happyvertical/smrt-config`).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const starterComposePath = fileURLToPath(
  new URL('../packages/template-sveltekit/template/compose.yaml', import.meta.url),
);
export const starterFixturePath = fileURLToPath(
  new URL('../charts/smrt-app/fixtures/starter.json', import.meta.url),
);

// The template builds one image and runs it as web, task worker and schedule
// worker, so one synthetic digest stands for all three. Like the other chart
// fixtures, this is an example and not a deployable release.
const image = `ghcr.io/example/starter@sha256:${'a'.repeat(64)}`;
export const starterImages = { web: image, worker: image, 'schedule-worker': image };

// Everything the environment owns. None of it is in the Compose file.
export const starterInputs = {
  release: { id: 'release-001', phase: 'maintenance', sequence: 0, attempt: 1 },
  app: { name: 'starter', environment: 'test' },
  bindings: {
    postgres: {
      runtime: { secretName: 'app-runtime-v1', secretKey: 'uri' },
      migration: { secretName: 'app-migration-v1', secretKey: 'uri' },
    },
  },
  defaults: {
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { cpu: '1', memory: '512Mi' },
    },
    terminationGracePeriodSeconds: 90,
  },
  workloads: {
    web: { replicas: 2 },
    worker: { role: 'task' },
    'schedule-worker': { role: 'schedule' },
  },
  migration: { terminationGracePeriodSeconds: 300 },
  maintenance: {
    image: `docker.io/library/nginx@sha256:${'b'.repeat(64)}`,
    command: ['nginx', '-g', 'daemon off;'],
    port: 8080,
    http: { path: '/', status: 503, body: 'Maintenance' },
  },
  ingress: { host: 'starter.example.invalid', className: 'nginx' },
};

export function readStarterCompose() {
  return parse(readFileSync(starterComposePath, 'utf8'), { merge: true });
}

/** The fixture file content the starter Compose file renders to. */
export async function renderStarterFixture() {
  const { renderSmrtAppChartValues, validateComposeDeployment, formatComposeDeploymentReport } =
    await import('../packages/config/dist/deployment.js');
  const result = validateComposeDeployment(readStarterCompose(), { stage: 'deploy', images: starterImages });
  if (!result.declaration) {
    throw new Error(`${starterComposePath}\n${formatComposeDeploymentReport(result)}`);
  }
  return `${JSON.stringify(renderSmrtAppChartValues(result.declaration, starterInputs), null, 2)}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rendered = await renderStarterFixture();
  if (process.argv.includes('--write')) {
    writeFileSync(starterFixturePath, rendered);
    console.log(`Wrote ${starterFixturePath}`);
  } else if (readFileSync(starterFixturePath, 'utf8') !== rendered) {
    console.error(
      `${starterFixturePath} is stale. Run: node scripts/compose-contract-fixture.mjs --write`,
    );
    process.exit(1);
  } else {
    console.log('charts/smrt-app/fixtures/starter.json matches the starter Compose file.');
  }
}

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve('.github/workflows/publish-package.yml'),
  'utf8',
);
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

const required = [
  'workflow_dispatch:',
  'mirror_version:',
  'mirror mode requires mirror_version',
  'mirror_version is only valid in mirror mode',
  "refs/heads/main",
  'environments/release',
  'deployment-branch-policies',
  'secrets.NPM_HAPPYVERTICAL_PUBLISH_TOKEN',
  'secrets.NPM_TOKEN',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  'pnpm test:package',
  'Verify downloaded publish input',
  'npm publish --dry-run --ignore-scripts "${tarballs[0]}"',
  'dist.integrity',
  'continue-on-error: true',
];

for (const text of required) {
  if (!workflow.includes(text)) {
    throw new Error(`publish workflow is missing ${JSON.stringify(text)}`);
  }
}

const forbidden = [
  'secrets.PLANNER_NPM_HAPPYVERTICAL_PUBLISH_TOKEN',
  'secrets.PLANNER_NPMJS_TOKEN',
  'pull_request:',
  'push:',
];
for (const text of forbidden) {
  if (workflow.includes(text)) {
    throw new Error(`publish workflow must not contain ${JSON.stringify(text)}`);
  }
}

const publishSecretNames = [
  'secrets.NPM_HAPPYVERTICAL_PUBLISH_TOKEN',
  'secrets.NPM_TOKEN',
];
const jobBlocks = workflow
  .slice(workflow.indexOf('\njobs:') + 1)
  .split(/\n(?=  [a-z][a-z0-9-]*:\n)/);
for (const block of jobBlocks) {
  if (
    publishSecretNames.some((name) => block.includes(name)) &&
    !block.includes('\n    environment: release\n')
  ) {
    throw new Error('every publish-secret job must use the release environment');
  }
}

for (const file of readdirSync(resolve('.github/workflows'))) {
  if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
  const source = readFileSync(resolve('.github/workflows', file), 'utf8');
  if (
    source.includes('pull_request:') &&
    publishSecretNames.some((name) => source.includes(name))
  ) {
    throw new Error(`${file} exposes a publish secret to a pull-request workflow`);
  }
}

const bestEffortJobs = workflow.match(/continue-on-error: true/g) ?? [];
if (bestEffortJobs.length !== 1) {
  throw new Error('only the release-mode npmjs mirror may be best effort');
}

if (workflow.includes('find release-artifact')) {
  throw new Error('npm tarball paths must not be ambiguous package specs');
}
const absoluteArtifactLookups =
  workflow.match(/find "\$PWD\/release-artifact"/g) ?? [];
if (absoluteArtifactLookups.length !== 5) {
  throw new Error('every packed or downloaded tarball lookup must be absolute');
}

if (pkg.private === true) throw new Error('package remains private');
if (!/^0\.\d+\.\d+$/.test(pkg.version)) {
  throw new Error('only 0.x releases are automated');
}
for (const name of [
  '@happyvertical/smrt-chat',
  '@happyvertical/smrt-core',
  '@happyvertical/smrt-svelte',
  '@happyvertical/smrt-ui',
]) {
  if (pkg.dependencies[name] !== '^0.55.12') {
    throw new Error(`${name} must require the Kitchen-safe release floor`);
  }
}

console.log('protected publication workflow contract verified');

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const workflow = readFileSync(
  resolve('.github/workflows/publish-package.yml'),
  'utf8',
);
const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));

const required = [
  'workflow_dispatch:',
  "refs/heads/main",
  'environments/release',
  'deployment-branch-policies',
  'PLANNER_NPM_HAPPYVERTICAL_PUBLISH_TOKEN',
  'PLANNER_NPMJS_TOKEN',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
  'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
  'pnpm test:package',
  'dist.integrity',
  'continue-on-error: true',
];

for (const text of required) {
  if (!workflow.includes(text)) {
    throw new Error(`publish workflow is missing ${JSON.stringify(text)}`);
  }
}

const forbidden = [
  'secrets.NPM_HAPPYVERTICAL_PUBLISH_TOKEN',
  'secrets.NPM_TOKEN',
  'pull_request:',
  'push:',
];
for (const text of forbidden) {
  if (workflow.includes(text)) {
    throw new Error(`publish workflow must not contain ${JSON.stringify(text)}`);
  }
}

const bestEffortJobs = workflow.match(/continue-on-error: true/g) ?? [];
if (bestEffortJobs.length !== 1) {
  throw new Error('only the release-mode npmjs mirror may be best effort');
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

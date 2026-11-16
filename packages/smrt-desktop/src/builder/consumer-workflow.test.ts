import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  NODE_PINS_PACKAGE_PATH,
  TAURI_CLI_VERSION,
  WRAPPER_SIGNING_TOOLS,
  WRAPPER_TOOLS,
} from './constants.js';

/**
 * Structure of the reusable consumer workflow (smrt#4965). Text based on
 * purpose: no YAML dependency, and the checks are about where a secret may
 * appear, which is a property of the file's layout.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolve(packageDir, '..', '..');
const text = readFileSync(
  join(repoRoot, '.github/workflows/desktop-consumer-build.yml'),
  'utf8',
);
const preflightSource = readFileSync(
  join(packageDir, 'wrapper/scripts/release-preflight.mjs'),
  'utf8',
);

interface Step {
  name: string;
  body: string;
}
interface Job {
  id: string;
  body: string;
  steps: Step[];
}

const jobsText = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
const jobs: Job[] = jobsText
  .split(/^(?= {2}[a-z][a-z-]*:\n)/m)
  .filter((chunk) => /^ {2}[a-z][a-z-]*:\n/.test(chunk))
  .map((chunk) => {
    const id = /^ {2}([a-z][a-z-]*):/.exec(chunk)?.[1] ?? '';
    const parts = chunk.split(/^(?= {6}- name: )/m);
    const steps = parts.slice(1).map((part) => ({
      name: /- name: (.*)/.exec(part)?.[1] ?? '',
      body: part,
    }));
    return { id, body: chunk, steps };
  });
const job = (id: string): Job => {
  const found = jobs.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no job ${id}`);
  return found;
};

const SECRETS = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
];
const secretNames = (body: string) =>
  [...body.matchAll(/\$\{\{\s*secrets\.([A-Z_]+)\s*\}\}/g)].map((m) => m[1]);
const nonComment = (body: string) =>
  body
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');

describe('the consumer workflow keeps secret custody (smrt#4965)', () => {
  it('has the jobs plan, release-preflight, build, sign and publish', () => {
    expect(jobs.map((j) => j.id)).toEqual([
      'plan',
      'tools',
      'release-preflight',
      'build',
      'sign',
      'publish',
    ]);
  });

  it('declares exactly the secrets the preflight requires', () => {
    const declared = [
      ...text.matchAll(/^ {6}([A-Z_]+):\n {8}required: false/gm),
    ]
      .map((m) => m[1])
      .sort();
    const required = [
      ...(
        /REQUIRED_SECRETS = Object\.freeze\(\[([^\]]*)\]/.exec(
          preflightSource,
        )?.[1] ?? ''
      ).matchAll(/'([A-Z_]+)'/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(declared).toEqual([...SECRETS].sort());
    expect(required).toEqual(declared);
  });

  it('reads a secret only in the named steps of the preflight and sign jobs', () => {
    const allowed: Record<string, Record<string, string[]>> = {
      'release-preflight': { 'Check secrets and product inputs': SECRETS },
      sign: {
        'Import the signing certificate (macOS)': [
          'APPLE_CERTIFICATE',
          'APPLE_CERTIFICATE_PASSWORD',
        ],
        'Sign and notarize (macOS)': [
          'APPLE_SIGNING_IDENTITY',
          'APPLE_ID',
          'APPLE_PASSWORD',
          'APPLE_TEAM_ID',
        ],
        'Sign the updater payload': [
          'TAURI_SIGNING_PRIVATE_KEY',
          'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
        ],
      },
    };
    for (const j of jobs) {
      // job-level env, matrix, if and permissions never carry a secret
      const head = j.body.slice(
        0,
        j.steps[0] ? j.body.indexOf(j.steps[0].body) : undefined,
      );
      expect(secretNames(head), `${j.id} header`).toEqual([]);
      for (const step of j.steps) {
        const expected = allowed[j.id]?.[step.name] ?? [];
        expect(secretNames(step.body).sort(), `${j.id}: ${step.name}`).toEqual(
          [...expected].sort(),
        );
        // always in the step's own env mapping, never inline in a script
        for (const name of expected) {
          expect(step.body).toContain(`${name}: \${{ secrets.${name} }}`);
        }
      }
    }
    expect(secretNames(text.slice(0, text.indexOf('\njobs:\n')))).toEqual([]);
  });

  it('never installs, builds or runs caller code in the sign job', () => {
    const sign = job('sign');
    const code = nonComment(sign.body);
    for (const forbidden of [
      /\bcargo\b/,
      /\brustup\b/,
      /\bsmrt\b\s+(app|desktop)/,
      /tauri\s+build/,
      /pnpm[^\n]*\bbuild\b/,
      /actions\/cache/,
    ]) {
      expect(code).not.toMatch(forbidden);
    }
    // nothing is installed or downloaded after the first secret step
    const first = sign.steps.findIndex((s) => secretNames(s.body).length > 0);
    expect(first).toBeGreaterThan(0);
    for (const step of sign.steps.slice(first)) {
      expect(nonComment(step.body), step.name).not.toMatch(
        /\b(npm|pnpm)\s+(ci|install|i)\b|actions\/setup-|download-artifact/,
      );
    }
    // the cleanup is the last step and always runs
    const last = sign.steps[sign.steps.length - 1];
    expect(last?.body).toMatch(/if: always\(\)/);
    expect(last?.body).toContain('security delete-keychain');
  });

  it('keeps the unsigned build and the plan free of secrets, environments and writes', () => {
    for (const id of ['plan', 'build']) {
      const body = nonComment(job(id).body);
      expect(body, id).not.toMatch(/\benvironment:/);
      expect(body, id).not.toMatch(/contents:\s*write/);
      expect(body, id).not.toContain('secrets.');
    }
    expect(job('build').body).not.toMatch(/\bGH_TOKEN\b|github\.token/);
  });

  it('writes contents only in the publish job, which holds no secret', () => {
    for (const j of jobs) {
      const writes = /contents:\s*write/.test(nonComment(j.body));
      expect(writes, j.id).toBe(j.id === 'publish');
    }
    expect(secretNames(job('publish').body)).toEqual([]);
    expect(job('publish').body).toMatch(/needs: \[plan, tools, sign\]/);
  });

  it('runs the release legs in the desktop-release environment, on a release only', () => {
    for (const id of ['release-preflight', 'sign', 'publish']) {
      expect(job(id).body, id).toMatch(/environment: desktop-release/);
      expect(job(id).body, id).toMatch(/if: inputs\.release/);
    }
    // nothing builds before the preflight passed, and a failed one stops it
    const build = job('build').body;
    expect(build).toContain('needs: [plan, release-preflight]');
    expect(build).toContain("needs.release-preflight.result == 'success'");
    expect(build).toContain("needs.release-preflight.result == 'skipped'");
    expect(job('sign').body).toContain(
      'needs: [plan, tools, release-preflight, build]',
    );
    expect(text).not.toMatch(/continue-on-error/);
  });

  it('is fail-closed: no unsigned-release switch and the pins are required', () => {
    expect(text).not.toMatch(/unsigned_release|skip_sign|allow_unsigned/i);
    expect(job('build').body).toContain('--require-verified-pins');
    expect(job('release-preflight').body).toContain('--secrets');
  });

  it('resolves every release script from the installed package', () => {
    const code = nonComment(text);
    expect(code).not.toMatch(/packages\/smrt-desktop|WRAPPER_DIR|\.github\//);
    for (const id of ['release-preflight', 'sign', 'publish']) {
      const body = job(id).body;
      expect(body, id).toContain('Download the release tools');
      expect(body, id).toContain('name: desktop-tools');
      for (const script of body.matchAll(
        /node "\$[A-Z_]+\/wrapper\/scripts\/([a-z-]+\.mjs)"/g,
      )) {
        expect(body).toContain(`"$DESKTOP_PKG/wrapper/scripts/${script[1]}"`);
      }
    }
    expect(code).not.toMatch(/node "[^$"][^"]*\.mjs"/);
  });

  it('hops the bundle and the unsigned output as directories, never archives', () => {
    const build = job('build');
    const hops = build.steps.filter((s) =>
      /name: desktop-(bundle|unsigned)-/.test(s.body),
    );
    expect(hops).toHaveLength(2);
    for (const step of hops) {
      expect(step.body).toContain('if: inputs.release');
      expect(step.body).not.toMatch(/\.tar\b/);
    }
    const sign = job('sign').body;
    expect(sign).toContain('name: desktop-bundle-${{ matrix.target }}');
    expect(sign).toContain('name: desktop-unsigned-${{ matrix.target }}');
    expect(nonComment(sign)).not.toMatch(/\btar\s+-x|unzip/);
  });

  it('installs the signing CLI from the packaged lockfile with scripts off', () => {
    const step = job('sign').steps.find(
      (s) => s.name === 'Install the locked Tauri CLI',
    );
    expect(step?.body).toContain('npm ci --ignore-scripts');
    expect(step?.body).toContain('signing-tools/package-lock.json');
    expect(secretNames(step?.body ?? '')).toEqual([]);
  });

  it('locks the packaged signing CLI to the pinned Tauri CLI version', () => {
    const dir = join(packageDir, 'wrapper/signing-tools');
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(
      readFileSync(join(dir, 'package-lock.json'), 'utf8'),
    );
    expect(pkg.dependencies).toEqual({ '@tauri-apps/cli': TAURI_CLI_VERSION });
    expect(lock.packages['node_modules/@tauri-apps/cli'].version).toBe(
      TAURI_CLI_VERSION,
    );
  });

  it('installs nothing of the caller in any job that has an environment', () => {
    const withEnvironment = jobs.filter((j) =>
      /^ {4}environment:/m.test(j.body),
    );
    expect(withEnvironment.map((j) => j.id)).toEqual([
      'release-preflight',
      'sign',
      'publish',
    ]);
    for (const j of withEnvironment) {
      const code = nonComment(j.body);
      // no pnpm, no pnpmfile, no caller lockfile install: the packaged tools
      // arrive as an artifact from the no-environment `tools` job
      expect(code, j.id).not.toMatch(/\bpnpm\b/);
      expect(code, j.id).not.toMatch(/\bnpm\s+(install|i|exec|run|x)\b|npx\b/);
      expect(code, j.id).not.toContain('pnpm-lock');
      // the one npm call is the locked, script-less signing CLI install
      for (const call of code.matchAll(/\bnpm\s+ci\b[^\n]*/g)) {
        expect(j.id).toBe('sign');
        expect(call[0]).toContain('--ignore-scripts');
        expect(call[0]).toContain('--prefix "$SIGNING_TOOLS"');
      }
    }
    // the caller's install happens only in the environment-free tools job
    const tools = job('tools');
    expect(tools.body).not.toMatch(/\benvironment:/);
    expect(tools.body).not.toContain('secrets.');
    expect(tools.body).toMatch(/permissions:\n {6}contents: read\n/);
    expect(tools.body).toContain('install --frozen-lockfile --ignore-scripts');
  });

  it('hands over exactly the packaged tools the legs run', () => {
    const body = job('tools').body;
    for (const file of [...WRAPPER_TOOLS, ...WRAPPER_SIGNING_TOOLS]) {
      expect(body, file).toContain(file.split('/').pop() as string);
    }
    expect(body).toContain(NODE_PINS_PACKAGE_PATH);
    expect(WRAPPER_TOOLS).toContain('scripts/release-environment.mjs');
    // every script an environment job runs is one of the handed-over files
    for (const id of ['release-preflight', 'sign', 'publish']) {
      for (const m of job(id).body.matchAll(
        /\$DESKTOP_PKG\/wrapper\/scripts\/([a-z-]+\.mjs)/g,
      )) {
        expect(WRAPPER_TOOLS, m[1]).toContain(`scripts/${m[1]}`);
      }
    }
  });

  it('checks the environment protection in the preflight with actions: read', () => {
    const preflight = job('release-preflight');
    expect(preflight.body).toMatch(
      /permissions:\n {6}contents: read\n {6}actions: read\n/,
    );
    const step = preflight.steps.find(
      (s) => s.name === 'Verify the environment is protected',
    );
    expect(step?.body).toContain('release-environment.mjs');
    expect(step?.body).toContain('--environment desktop-release');
    expect(step?.body).toContain('--branch "$BRANCH"');
    expect(step?.body).toContain('default_branch');
    expect(secretNames(step?.body ?? '')).toEqual([]);
    // it runs before the secrets step
    const names = preflight.steps.map((s) => s.name);
    expect(names.indexOf('Verify the environment is protected')).toBeLessThan(
      names.indexOf('Check secrets and product inputs'),
    );
  });

  it('serializes publishing without cancelling a publish in flight', () => {
    const body = job('publish').body;
    expect(body).toMatch(/concurrency:\n {6}group: desktop-release-publish-/);
    expect(body).toMatch(/cancel-in-progress: false/);
    expect(text).not.toMatch(/cancel-in-progress: true/);
  });

  it('publishes the planner-normalized targets', () => {
    expect(job('plan').body).toContain(
      'targets: ${{ steps.plan.outputs.targets }}',
    );
    expect(job('plan').body).toContain('"targets=" + targets.join(",")');
    const publish = job('publish').body;
    expect(publish).toContain('TARGETS: ${{ needs.plan.outputs.targets }}');
    expect(publish).not.toContain('inputs.targets');
  });

  it('says the bridge is required for a release', () => {
    const description =
      /bridge_path:\n {8}description: >-\n((?: {10}.*\n)+)/.exec(text)?.[1];
    expect(description).toMatch(/REQUIRED when release is true/);
    expect(description).not.toMatch(/Empty omits it\./);
  });
});

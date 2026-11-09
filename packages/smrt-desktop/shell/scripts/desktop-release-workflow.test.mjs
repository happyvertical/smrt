// Run with: node --test scripts/desktop-release-workflow.test.mjs
// Keeps the signing secrets apart from the build. The real workflow must pass;
// every mutation below mixes the two and must fail.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkWorkflow, parseWorkflow } from './desktop-release-workflow-lint.mjs';

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
      .filter((job) => job.steps.some((s) => /secrets\./.test(s.text)))
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
      /holds a secret|must be exactly one allowed/,
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
        '      - name: Install the pinned Tauri CLI\n        if: runner.os != \'Linux\'\n',
        `      - name: Install the pinned Tauri CLI\n        if: runner.os != 'Linux'\n        env:\n${SECRET_LINE}`,
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

describe('a secret step must be exactly an allowed signing command', () => {
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
          '          test "${#payloads[@]}" -eq 1\n          tauri signer sign "${payloads[0]}"',
          `          test "\${#payloads[@]}" -eq 1\n          ${extra}\n          tauri signer sign "\${payloads[0]}"`,
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
      /exactly one allowed signing command/,
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
      /npm other than the pinned/,
    );
    fails(
      mutate(
        'npm install --global --ignore-scripts "@tauri-apps/cli@${TAURI_CLI_VERSION}"\n\n      # SECRET STEP 1',
        'npm install --global "@tauri-apps/cli@${TAURI_CLI_VERSION}"\n\n      # SECRET STEP 1',
      ),
      /npm other than the pinned/,
    );
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

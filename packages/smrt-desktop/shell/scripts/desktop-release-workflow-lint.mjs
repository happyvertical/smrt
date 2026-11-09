// Structural checks on .github/workflows/desktop-release.yml: signing is kept
// apart from building. A small line-based reader (no YAML dependency, so the
// check runs wherever `node --test` does) splits the workflow into jobs and
// steps and applies the rules below. A future edit that mixes them fails
// desktop-release-workflow.test.mjs.
//
// Rules
//  1. `secrets.*` appears only inside a step: never at workflow or job level.
//  2. A step that holds a secret has no `uses:` (no third-party code gets one)
//     and is exactly one of the allowed signing commands, each with only its
//     own secrets (see SECRET_STEPS). It runs nothing that builds, installs or
//     fetches (cargo, rustup, npm, npx, pnpm, yarn, tauri build, curl, ...),
//     runs `node` only for the preflight script, runs `tauri` only as
//     `tauri signer sign`, and cannot write GITHUB_ENV/PATH/OUTPUT.
//  3. A step that builds or installs (cargo, rustup, tauri build, pnpm, npm
//     install, tauri-action) holds no secret.
//  4. A job that has a secret step runs no cargo, rustup, tauri build, pnpm,
//     yarn, npx or local action; its only npm commands are the pinned Tauri
//     CLI install and uninstall; its `uses:` are the pinned checkout, node,
//     and artifact actions; it is in the `desktop-release` environment; and a
//     job that imports a certificate ends with an always() cleanup that
//     deletes the keychain and uninstalls the CLI.
//  5. Every cargo build/test/check/clippy/run/install and every `tauri build`
//     has `--locked` (for tauri after `--`).
//  6. The Rust toolchain and Node versions are exact, not `stable` or a line.

const TOOL_VERSION = /^\d+\.\d+\.\d+$/;
const PINNED_ACTION =
  /^(actions\/(checkout|setup-node|download-artifact|upload-artifact))@[0-9a-f]{40}$/;
const ENVIRONMENT = 'desktop-release';

/** Allowed commands for a step that holds secrets, and the secrets each may hold. */
export const SECRET_STEPS = Object.freeze([
  {
    id: 'preflight presence check',
    pattern: /^node "\$SHELL_DIR\/scripts\/release-preflight\.mjs"/m,
    secrets: [
      'APPLE_CERTIFICATE',
      'APPLE_CERTIFICATE_PASSWORD',
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
      'TAURI_SIGNING_PRIVATE_KEY',
      'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    ],
  },
  {
    id: 'certificate import',
    pattern: /\bsecurity import\b/,
    secrets: ['APPLE_CERTIFICATE', 'APPLE_CERTIFICATE_PASSWORD'],
  },
  {
    id: 'codesign and notarize',
    pattern: /\bxcrun notarytool submit\b/,
    secrets: [
      'APPLE_SIGNING_IDENTITY',
      'APPLE_ID',
      'APPLE_PASSWORD',
      'APPLE_TEAM_ID',
    ],
  },
  {
    id: 'updater signature',
    pattern: /\btauri signer sign\b/,
    secrets: ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD'],
  },
]);

// Anything that compiles, installs or downloads code.
const BUILD_OR_INSTALL =
  /\b(cargo|rustup|rustc|npm|npx|pnpm|yarn|pip3?|curl|wget|brew|gem)\b|\btauri\s+(build|dev|bundle|init|add)\b|tauri-action/;
const LOCAL_BUILD =
  /\b(cargo|rustup|rustc|pnpm|yarn|npx)\b|\btauri\s+(build|dev|bundle|init|add)\b|tauri-action/;
const PINNED_NPM = [
  /^npm install --global --ignore-scripts "@tauri-apps\/cli@\$\{TAURI_CLI_VERSION\}"$/,
  /^npm uninstall --global @tauri-apps\/cli( \|\| true)?$/,
];

const stripComments = (lines) =>
  lines.filter((line) => !/^\s*#/.test(line));

/** Join `\` continuations so one command is one line. */
function logicalLines(text) {
  return text
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

function parseStep(rawLines) {
  const lines = stripComments(rawLines);
  // "      - name: x" -> keys at one indent
  const keyed = lines.map((line, index) =>
    index === 0 ? line.replace(/^(\s*)- /, '$1  ') : line,
  );
  const step = { text: keyed.join('\n'), keys: {} };
  let key;
  for (const line of keyed) {
    const match = /^ {8}([A-Za-z_-]+):\s?(.*)$/.exec(line);
    if (match) {
      key = match[1];
      step.keys[key] = [match[2]];
    } else if (key) {
      step.keys[key].push(line);
    }
  }
  const scalar = (name) => step.keys[name]?.[0]?.replace(/\s+#.*$/, '').trim();
  step.name = scalar('name') ?? '(unnamed)';
  step.uses = scalar('uses');
  step.if = scalar('if');
  const run = step.keys.run;
  if (run) {
    step.run =
      run[0] === '|' || run[0] === '>'
        ? run
            .slice(1)
            .map((line) => line.replace(/^ {10}/, ''))
            .join('\n')
        : run[0];
  }
  return step;
}

/** Split the workflow into its pre-`jobs:` text and its jobs and steps. */
export function parseWorkflow(source) {
  const lines = source.split('\n');
  const jobsAt = lines.findIndex((line) => line === 'jobs:');
  if (jobsAt === -1) throw new Error('no jobs: section');
  const result = { head: stripComments(lines.slice(0, jobsAt)).join('\n'), jobs: [] };
  let current;
  for (const line of lines.slice(jobsAt + 1)) {
    const header = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (header) {
      current = { id: header[1], lines: [] };
      result.jobs.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }
  for (const job of result.jobs) {
    const stepsAt = job.lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
    if (stepsAt === -1) throw new Error(`job ${job.id} has no steps`);
    job.head = stripComments(job.lines.slice(0, stepsAt)).join('\n');
    job.steps = [];
    let block;
    for (const line of job.lines.slice(stepsAt + 1)) {
      if (/^ {6}- /.test(line)) {
        block = [line];
        job.steps.push(block);
      } else if (block) {
        block.push(line);
      }
    }
    job.steps = job.steps.map(parseStep);
    const env = /^ {4}environment:\s*(\S+)/m.exec(job.head);
    job.environment = env?.[1];
  }
  return result;
}

const secretNames = (text) =>
  [...text.matchAll(/\bsecrets\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]);

/** Returns the list of problems; empty means the separation holds. */
export function checkWorkflow(source) {
  const problems = [];
  const workflow = parseWorkflow(source);
  const add = (message) => problems.push(message);

  if (/\bsecrets\./.test(workflow.head)) {
    add('a secret is referenced at workflow level');
  }

  for (const job of workflow.jobs) {
    const where = `job ${job.id}`;
    if (/\bsecrets\./.test(job.head)) {
      add(`${where}: a secret is referenced at job level (every step would see it)`);
    }
    const holdsSecret = job.steps.some((step) => /\bsecrets\./.test(step.text));

    for (const step of job.steps) {
      const at = `${where}, step "${step.name}"`;
      const names = secretNames(step.text);
      const run = step.run ?? '';
      const commands = logicalLines(run).join('\n');

      if (names.length > 0) {
        if (step.uses) add(`${at}: a step that uses an action holds a secret`);
        const matches = SECRET_STEPS.filter((rule) => rule.pattern.test(commands));
        if (matches.length !== 1) {
          add(
            `${at}: a step with secrets must be exactly one allowed signing command (matched ${matches.length})`,
          );
        } else {
          for (const name of new Set(names)) {
            if (!matches[0].secrets.includes(name)) {
              add(`${at}: ${name} is not allowed in the ${matches[0].id} step`);
            }
          }
        }
        if (
          /\b(cargo|rustup|rustc|npm|npx|pnpm|yarn|pip3?|curl|wget|brew|gem)\b/.test(commands) ||
          /(^|[\s;&|(])tauri\s+(?!signer\s+sign\b)/m.test(commands) ||
          /tauri-action/.test(`${step.uses ?? ''}${commands}`)
        ) {
          add(`${at}: a step with secrets builds, installs, downloads or runs another tauri command`);
        }
        if (/\bnode\b(?!\s+"\$SHELL_DIR\/scripts\/release-preflight\.mjs")/.test(commands)) {
          add(`${at}: a step with secrets runs node for something other than the preflight`);
        }
        if (/GITHUB_(ENV|PATH|OUTPUT|STATE)/.test(commands)) {
          add(`${at}: a step with secrets writes to the workflow command files`);
        }
      }

      const buildsOrInstalls =
        BUILD_OR_INSTALL.test(commands) ||
        BUILD_OR_INSTALL.test(step.uses ?? '') ||
        /^\.\/\.github\/actions\//.test(step.uses ?? '');
      if (buildsOrInstalls && names.length > 0) {
        add(`${at}: a step that builds or installs holds a secret`);
      }

      for (const line of logicalLines(run)) {
        if (/\bcargo\s+(build|test|check|clippy|run|install|bench|doc)\b/.test(line) && !/--locked\b/.test(line)) {
          add(`${at}: cargo without --locked: ${line}`);
        }
        if (/\btauri\s+build\b/.test(line) && !/ -- .*--locked\b/.test(line)) {
          add(`${at}: tauri build without -- --locked: ${line}`);
        }
        if (/rustup\s+(toolchain\s+install|default)\s+(stable|beta|nightly)\b/.test(line)) {
          add(`${at}: a floating Rust toolchain: ${line}`);
        }
      }
      if (/^actions\/setup-node@/.test(step.uses ?? '')) {
        const version = step.keys.with?.join('\n') ?? '';
        if (!/node-version:\s*\$\{\{\s*env\.NODE_VERSION\s*\}\}/.test(version)) {
          add(`${at}: setup-node does not use the pinned NODE_VERSION`);
        }
      }
    }

    if (holdsSecret) {
      if (job.environment !== ENVIRONMENT) {
        add(`${where}: a job with secrets is not in the ${ENVIRONMENT} environment`);
      }
      for (const step of job.steps) {
        const at = `${where}, step "${step.name}"`;
        const commands = logicalLines(step.run ?? '');
        if (commands.some((line) => LOCAL_BUILD.test(line))) {
          add(`${at}: a job with secrets compiles or runs a package manager`);
        }
        for (const line of commands) {
          if (/\bnpm\b/.test(line) && !PINNED_NPM.some((rule) => rule.test(line))) {
            add(`${at}: npm other than the pinned Tauri CLI install/uninstall: ${line}`);
          }
        }
        if (step.uses && !PINNED_ACTION.test(step.uses)) {
          add(`${at}: a job with secrets uses an action that is not an allowed, SHA-pinned one`);
        }
      }
      if (job.steps.some((step) => /\bsecurity import\b/.test(step.run ?? ''))) {
        const cleanup = job.steps.at(-1);
        if (
          cleanup?.if !== 'always()' ||
          !/security delete-keychain/.test(cleanup.run ?? '') ||
          !/npm uninstall --global @tauri-apps\/cli/.test(cleanup.run ?? '')
        ) {
          add(`${where}: the last step must be an always() cleanup that deletes the keychain and uninstalls the CLI`);
        }
      }
    } else if (job.environment !== undefined && job.environment !== ENVIRONMENT) {
      add(`${where}: environment is not ${ENVIRONMENT}`);
    }
  }

  const env = /^ {2}RUST_TOOLCHAIN:\s*(\S+)/m.exec(workflow.head)?.[1];
  const node = /^ {2}NODE_VERSION:\s*(\S+)/m.exec(workflow.head)?.[1];
  if (!TOOL_VERSION.test(env ?? '')) add('RUST_TOOLCHAIN is not an exact version');
  if (!TOOL_VERSION.test(node ?? '')) add('NODE_VERSION is not an exact version');
  return problems;
}

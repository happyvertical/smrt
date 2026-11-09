// Structural checks on .github/workflows/desktop-release.yml: signing is kept
// apart from building. The workflow is parsed with the real `yaml` package
// (the same reading GitHub does), never by matching text, and the rules below
// run on the parsed structure. A future edit that mixes the two fails
// desktop-release-workflow.test.mjs.
//
// Rules
//  0. The file is one valid YAML document with no anchor, alias, merge key
//     (`<<`) or explicit tag. GitHub Actions accepts all of them, and each
//     can move a secret or a command into a step without that text appearing
//     there, so none is allowed anywhere in the file.
//  1. ANY reference to `secrets` (case-insensitive, whatever the syntax:
//     `secrets.X`, `secrets['X']`, `toJSON(secrets)`, `format(.., secrets)`, a
//     `secrets:` key such as `secrets: inherit`) lives only inside a step, and
//     inside it only as the exact value of an `env` entry of the same name
//     (`NAME: ${{ secrets.NAME }}`). Never at workflow or job level, in `with`,
//     in `if`, in `run`, in a name.
//  2. A step that holds a secret has no `uses:`, only the keys name / id / if
//     / env / run (no `shell`, no `working-directory`), matches exactly one
//     rule in SECRET_STEPS by its key command, holds only that rule's secrets
//     and plain env names, and EVERY logical line of its `run` is one of that
//     rule's listed lines (desktop-release-signing-commands.mjs). That is an
//     allow-list: a line that is not listed, whatever it is, fails. On top of
//     it, a builder, installer, downloader, another `tauri` command, `node`
//     other than the preflight script and a write to the workflow command
//     files are reported by name.
//  3. A step that builds or installs (cargo, rustup, tauri build, pnpm, npm
//     install, tauri-action) holds no secret.
//  4. A job that has a secret step runs no cargo, rustup, tauri build, pnpm,
//     yarn, npx or local action; its only npm command is `npm ci --ignore-
//     scripts ... --prefix "$SHELL_DIR/signing-tools"` (a committed lockfile,
//     see checkLockfile); its `uses:` are the pinned checkout, node, and
//     artifact actions; it is in the `desktop-release` environment; it has no
//     job-level `env` and no write permission; its default shell is bash; and
//     a job that imports a certificate ends with an always() cleanup that
//     deletes the keychain and removes the installed CLI.
//  5. Every cargo build/test/check/clippy/run/install and every `tauri build`
//     has `--locked` (for tauri after `--`).
//  6. The Rust toolchain and Node versions are exact, not `stable` or a line.
//  7. The job that reads the environment through the API (release-
//     environment.mjs) has exactly `contents: read` and `actions: read`.
//
// What this is not: it does not model bash. The allow-list is what makes a
// secret step's script reviewable; the unlisted-line check is the control, the
// named checks above only make the message clearer.

import { isAlias, parseDocument, visit } from 'yaml';
import { SECRET_STEPS } from './desktop-release-signing-commands.mjs';

export { SECRET_STEPS };

const TOOL_VERSION = /^\d+\.\d+\.\d+$/;
const PINNED_ACTION =
  /^(actions\/(checkout|setup-node|download-artifact|upload-artifact))@[0-9a-f]{40}$/;
const ENVIRONMENT = 'desktop-release';
const SECRET_STEP_KEYS = new Set(['name', 'id', 'if', 'env', 'run']);
// The only workflow-level env names. A name such as BASH_ENV, NODE_OPTIONS or
// LD_PRELOAD here would reach every step, including the ones holding secrets.
const WORKFLOW_ENV_NAMES = new Set([
  'CARGO_TERM_COLOR',
  'CARGO_INCREMENTAL',
  'SHELL_DIR',
  'TAURI_CLI_VERSION',
  'RUST_TOOLCHAIN',
  'NODE_VERSION',
]);
const CANONICAL_SECRET =
  /^\$\{\{\s*secrets\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

// Anything that compiles, installs or downloads code.
const BUILD_OR_INSTALL =
  /\b(cargo|rustup|rustc|npm|npx|pnpm|yarn|corepack|bun|deno|pip3?|pipx|curl|wget|brew|gem)\b|\btauri\s+(build|dev|bundle|init|add)\b|tauri-action/;
const LOCAL_BUILD =
  /\b(cargo|rustup|rustc|pnpm|yarn|npx|corepack|bun|deno)\b|\btauri\s+(build|dev|bundle|init|add)\b|tauri-action/;
// The one npm command a job that holds secrets may run: install exactly what
// the committed lockfile says, with lifecycle scripts off.
export const SIGNING_TOOLS_INSTALL =
  'npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org/ --prefix "$SHELL_DIR/signing-tools"';

/** Join `\` continuations so one command is one line; drop comment lines. */
export function logicalLines(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]*\\\n[ \t]*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (value === undefined ? undefined : String(value));

/** The expression text inside every `${{ ... }}` of a string (also unclosed). */
function expressionsOf(value) {
  return value
    .split('${{')
    .slice(1)
    .map((part) => part.split('}}')[0]);
}

/**
 * Every reference to `secrets` anywhere under `value`: `{ path, value, key }`.
 * A string counts when one of its expressions mentions `secrets` in any case,
 * or when it is an `if` condition (a bare expression) that does. A mapping key
 * counts when it is `secrets` (`secrets: inherit`) or an expression naming it.
 */
export function secretReferences(value, path = []) {
  const found = [];
  const mentions = (s) => /secrets/i.test(s);
  const walk = (node, at) => {
    if (typeof node === 'string') {
      const bare = at.at(-1) === 'if';
      if (expressionsOf(node).some(mentions) || (bare && mentions(node))) {
        found.push({ path: at, value: node, key: false });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...at, index]));
    } else if (isObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        if (/^secrets$/i.test(key) || expressionsOf(key).some(mentions)) {
          found.push({ path: [...at, key], value: key, key: true });
        }
        walk(item, [...at, key]);
      }
    }
  };
  walk(value, path);
  return found;
}

function toStep(raw, index) {
  const step = isObject(raw) ? raw : {};
  return {
    raw: step,
    index,
    name: text(step.name) ?? '(unnamed)',
    uses: text(step.uses),
    if: text(step.if)?.trim(),
    run: typeof step.run === 'string' ? step.run : undefined,
    env: isObject(step.env) ? step.env : {},
    with: isObject(step.with) ? step.with : {},
  };
}

/**
 * Parse the workflow. `problems` carries YAML errors and the anchors, aliases,
 * merge keys and tags rule 0 forbids; the rest of the result is read from the
 * parsed document, so block-scalar spelling, flow style and quoting cannot
 * change what is checked.
 */
export function parseWorkflow(source) {
  const problems = [];
  const doc = parseDocument(source, { uniqueKeys: true, merge: false });
  for (const error of doc.errors) {
    problems.push(`YAML error: ${error.message.split('\n')[0]}`);
  }
  for (const warning of doc.warnings) {
    problems.push(`YAML warning: ${warning.message.split('\n')[0]}`);
  }
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) {
        problems.push(`a YAML alias (*${node.source}) is not allowed`);
      } else if (node.anchor) {
        problems.push(`a YAML anchor (&${node.anchor}) is not allowed`);
      }
      if (node.tag) problems.push(`a YAML tag (${node.tag}) is not allowed`);
    },
    Pair(_key, pair) {
      if (pair.key?.value === '<<') {
        problems.push('a YAML merge key (<<) is not allowed');
      }
    },
  });
  let raw = {};
  try {
    raw = doc.toJS({ maxAliasCount: -1 }) ?? {};
  } catch (error) {
    problems.push(`YAML could not be read: ${error.message}`);
  }
  if (!isObject(raw)) {
    problems.push('the workflow is not a mapping');
    raw = {};
  }
  const { jobs: rawJobs, ...top } = raw;
  if (!isObject(rawJobs)) problems.push('no jobs: mapping');
  const jobs = Object.entries(isObject(rawJobs) ? rawJobs : {}).map(
    ([id, job]) => {
      const body = isObject(job) ? job : {};
      if (!Array.isArray(body.steps)) {
        problems.push(`job ${id} has no steps`);
      }
      const { steps, ...head } = body;
      return {
        id,
        head,
        steps: (Array.isArray(steps) ? steps : []).map(toStep),
        environment:
          typeof body.environment === 'string'
            ? body.environment
            : body.environment?.name,
        permissions: body.permissions,
      };
    },
  );
  return { problems, top, env: isObject(top.env) ? top.env : {}, jobs };
}

/** Returns the list of problems; empty means the separation holds. */
export function checkWorkflow(source) {
  const workflow = parseWorkflow(source);
  const problems = [...workflow.problems];
  const add = (message) => problems.push(message);

  if (secretReferences(workflow.top).length > 0) {
    add('a secret is referenced at workflow level');
  }
  for (const name of Object.keys(workflow.env)) {
    if (!WORKFLOW_ENV_NAMES.has(name)) {
      add(`workflow-level env ${name} is not one of the allowed names`);
    }
  }

  for (const job of workflow.jobs) {
    const where = `job ${job.id}`;
    if (secretReferences(job.head).length > 0) {
      add(`${where}: a secret is referenced at job level (every step would see it)`);
    }
    const holdsSecret = job.steps.some(
      (step) => secretReferences(step.raw).length > 0,
    );

    for (const step of job.steps) {
      const at = `${where}, step "${step.name}"`;
      const refs = secretReferences(step.raw);
      const run = step.run ?? '';
      const commands = logicalLines(run).join('\n');

      if (refs.length > 0) {
        const names = [];
        for (const ref of refs) {
          const match = CANONICAL_SECRET.exec(ref.value);
          if (
            !ref.key &&
            ref.path.length === 2 &&
            ref.path[0] === 'env' &&
            match &&
            match[1] === ref.path[1]
          ) {
            names.push(match[1]);
          } else {
            add(
              `${at}: secrets is referenced other than as the exact value of its own env entry (${ref.path.join('.')})`,
            );
          }
        }
        if (step.uses) add(`${at}: a step that uses an action holds a secret`);
        for (const key of Object.keys(step.raw)) {
          if (!SECRET_STEP_KEYS.has(key)) {
            add(`${at}: a step with secrets may not set ${key}`);
          }
        }
        const matches = SECRET_STEPS.filter((rule) => rule.key.test(commands));
        if (matches.length !== 1) {
          add(
            `${at}: a step with secrets must be made only of allow-listed signing commands (matched ${matches.length} signing commands)`,
          );
        } else {
          const rule = matches[0];
          for (const name of new Set(names)) {
            if (!rule.secrets.includes(name)) {
              add(`${at}: ${name} is not allowed in the ${rule.id} step`);
            }
          }
          for (const name of Object.keys(step.env)) {
            if (!names.includes(name) && !rule.env.includes(name)) {
              add(`${at}: env ${name} is not allowed in the ${rule.id} step`);
            }
          }
          for (const line of logicalLines(run)) {
            const listed = rule.lines.some((allowed) =>
              typeof allowed === 'string' ? allowed === line : allowed.test(line),
            );
            if (!listed) {
              add(`${at}: not an allow-listed signing command: ${line}`);
            }
          }
        }
        if (
          /\b(cargo|rustup|rustc|npm|npx|pnpm|yarn|corepack|bun|deno|pip3?|pipx|curl|wget|brew|gem)\b/.test(commands) ||
          /(^|[\s;&|("])[^\s;&|("]*\/?tauri"?\s+(?!signer\s+sign\b)/m.test(commands) ||
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
      if (buildsOrInstalls && refs.length > 0) {
        add(`${at}: a step that builds or installs holds a secret`);
      }

      for (const line of logicalLines(run)) {
        if (/\bcargo\s+(build|test|check|clippy|run|install|bench|doc)\b/.test(line) && !/--locked\b/.test(line)) {
          add(`${at}: cargo without --locked: ${line}`);
        }
        if (/\btauri"?\s+build\b/.test(line) && !/ -- .*--locked\b/.test(line)) {
          add(`${at}: tauri build without -- --locked: ${line}`);
        }
        if (/rustup\s+(toolchain\s+install|default)\s+(stable|beta|nightly)\b/.test(line)) {
          add(`${at}: a floating Rust toolchain: ${line}`);
        }
      }
      if (/^actions\/setup-node@/.test(step.uses ?? '')) {
        const version = text(step.with['node-version']) ?? '';
        if (!/^\$\{\{\s*env\.NODE_VERSION\s*\}\}$/.test(version.trim())) {
          add(`${at}: setup-node does not use the pinned NODE_VERSION`);
        }
      }
      if (/release-environment\.mjs/.test(run)) {
        const permissions = job.permissions;
        if (
          !isObject(permissions) ||
          Object.keys(permissions).sort().join() !== 'actions,contents' ||
          permissions.actions !== 'read' ||
          permissions.contents !== 'read'
        ) {
          add(
            `${where}: the job that reads the environment through the API must have exactly "contents: read" and "actions: read"`,
          );
        }
      }
    }

    if (holdsSecret) {
      if (job.environment !== ENVIRONMENT) {
        add(`${where}: a job with secrets is not in the ${ENVIRONMENT} environment`);
      }
      if (job.head.env !== undefined) {
        add(`${where}: a job with secrets sets job-level env`);
      }
      const shell = job.head.defaults?.run?.shell;
      if (shell !== undefined && shell !== 'bash') {
        add(`${where}: a job with secrets sets its default shell to ${shell}`);
      }
      if (
        !isObject(job.permissions) ||
        Object.values(job.permissions).includes('write')
      ) {
        add(`${where}: a job with secrets has no explicit read-only permissions`);
      }
      for (const step of job.steps) {
        const at = `${where}, step "${step.name}"`;
        const commands = logicalLines(step.run ?? '');
        if (commands.some((line) => LOCAL_BUILD.test(line))) {
          add(`${at}: a job with secrets compiles or runs a package manager`);
        }
        for (const line of commands) {
          if (/\bnpm\b/.test(line) && line !== SIGNING_TOOLS_INSTALL) {
            add(`${at}: npm other than the locked signing-tools install: ${line}`);
          }
        }
        if (step.uses && !PINNED_ACTION.test(step.uses)) {
          add(`${at}: a job with secrets uses an action that is not an allowed, SHA-pinned one`);
        }
      }
      const importsCertificate = job.steps.some((step) =>
        logicalLines(step.run ?? '').some((line) => /^security import /.test(line)),
      );
      if (importsCertificate) {
        const cleanup = job.steps.at(-1);
        const cleanupLines = logicalLines(cleanup?.run ?? '');
        if (
          cleanup?.if !== 'always()' ||
          !cleanupLines.some((line) => /^security delete-keychain /.test(line)) ||
          !cleanupLines.includes('rm -rf "$SHELL_DIR/signing-tools/node_modules"')
        ) {
          add(`${where}: the last step must be an always() cleanup that deletes the keychain and removes the installed CLI`);
        }
      }
    } else if (job.environment !== undefined && job.environment !== ENVIRONMENT) {
      add(`${where}: environment is not ${ENVIRONMENT}`);
    }
  }

  const rust = text(workflow.env.RUST_TOOLCHAIN);
  const node = text(workflow.env.NODE_VERSION);
  if (!TOOL_VERSION.test(rust ?? '')) add('RUST_TOOLCHAIN is not an exact version');
  if (!TOOL_VERSION.test(node ?? '')) add('NODE_VERSION is not an exact version');
  return problems;
}

/**
 * Problems with a committed npm lockfile that a CI job installs with `npm ci`:
 * every package has a sha512 integrity and a resolution on the public npm
 * registry (no git, file, link or other host), and nothing lacks an entry.
 * `expected` (optional) is `{ name, version }` for the single direct
 * dependency, whose optional platform packages must all be locked too.
 */
export function checkLockfile(lockText, packageText, expected) {
  const problems = [];
  let lock;
  let pkg;
  try {
    lock = JSON.parse(lockText);
    pkg = JSON.parse(packageText);
  } catch (error) {
    return [`lockfile or package.json is not JSON: ${error.message}`];
  }
  if (!(lock.lockfileVersion >= 2) || !isObject(lock.packages)) {
    return ['lockfile is not an npm v2/v3 lockfile with a packages table'];
  }
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '');
  if (entries.length === 0) problems.push('lockfile locks no package');
  for (const [path, entry] of entries) {
    if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity ?? '')) {
      problems.push(`${path}: no sha512 integrity`);
    }
    if (!/^https:\/\/registry\.npmjs\.org\//.test(entry.resolved ?? '')) {
      problems.push(`${path}: not resolved from registry.npmjs.org (${entry.resolved})`);
    }
    if (entry.link || entry.inBundle) problems.push(`${path}: a link or bundled package`);
  }
  const direct = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  for (const [name, range] of Object.entries(direct)) {
    if (!/^\d+\.\d+\.\d+$/.test(range)) {
      problems.push(`package.json: ${name} is not an exact version (${range})`);
    }
    if (lock.packages[`node_modules/${name}`]?.version !== range) {
      problems.push(`${name}: the lockfile does not lock ${range}`);
    }
  }
  if (expected) {
    if (Object.keys(direct).join() !== expected.name || direct[expected.name] !== expected.version) {
      problems.push(`package.json must depend on exactly ${expected.name}@${expected.version}`);
    }
    const main = lock.packages[`node_modules/${expected.name}`];
    if (main?.version !== expected.version) {
      problems.push(`${expected.name}: the lockfile does not lock ${expected.version}`);
    }
    for (const [name, version] of Object.entries(main?.optionalDependencies ?? {})) {
      if (lock.packages[`node_modules/${name}`]?.version !== version) {
        problems.push(`${name}@${version}: an optional platform package is not locked`);
      }
    }
  }
  return problems;
}

/** `TAURI_CLI_VERSION` of a workflow, for comparing with the lockfile. */
export function workflowTauriCliVersion(source) {
  return text(parseWorkflow(source).env.TAURI_CLI_VERSION);
}

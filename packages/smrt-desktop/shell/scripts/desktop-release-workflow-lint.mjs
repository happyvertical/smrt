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
//     files are reported by name. A comment line never joins the line after
//     it (see logicalLines), and a string that holds a `${{` expression is
//     searched whole for `secrets`, not up to its first `}}`.
//  3. A step that builds or installs (cargo, rustup, tauri build, pnpm, npm
//     install, tauri-action) holds no secret.
//  4. A job that has a secret step runs no cargo, rustup, tauri build, pnpm,
//     yarn, npx or local action; its only npm command is `npm ci --ignore-
//     scripts ... --prefix "$SHELL_DIR/signing-tools"` (a committed lockfile,
//     see checkLockfile); its `uses:` are the pinned checkout, node, and
//     artifact actions; it is in the `desktop-release` environment; it has no
//     job-level `env` and no write permission; its `defaults.run.shell` is
//     exactly bash and it sets no `defaults.run.working-directory` (nor does
//     the workflow); EVERY other step of it is held to the build/install,
//     interpreter and command-file checks, except the VETTED_STEPS matched by
//     their exact `run` text; and a job that imports a certificate ends with
//     the exact CLEANUP_STEP under `if: always()`.
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
import {
  CLEANUP_STEP,
  SECRET_STEPS,
  SIGNING_TOOLS_INSTALL,
  VETTED_STEPS,
} from './desktop-release-signing-commands.mjs';

export { CLEANUP_STEP, SECRET_STEPS, SIGNING_TOOLS_INSTALL, VETTED_STEPS };

const TOOL_VERSION = /^\d+\.\d+\.\d+$/;
const PINNED_ACTION =
  /^(actions\/(checkout|setup-node|download-artifact|upload-artifact))@[0-9a-f]{40}$/;
const ENVIRONMENT = 'desktop-release';
const SECRET_STEP_KEYS = new Set(['name', 'id', 'if', 'env', 'run']);
const CLEANUP_KEYS = new Set(['name', 'if', 'run']);
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
// Interpreters and ways to run code that is not in the step's own text. Applied
// to every step of a job that holds a secret, next to BUILD_OR_INSTALL.
const RUNS_OTHER_CODE =
  /\bnode\s+(-[A-Za-z]*[eprc]\b|--(eval|print|require|import|input-type)\b)|\b(python[0-9.]*|perl|ruby|php|lua|osascript|pwsh|powershell|eval|source)\b|(^|[\s;&|(])\.\s+\S|\b(ba|z|da|k)?sh\s+-[A-Za-z]*c\b|\bbase64\s+(-d|-D|--decode)\b/;
// The files a step writes to change the environment of the steps after it.
const COMMAND_FILES = /GITHUB_(ENV|PATH|OUTPUT|STATE)/;
// Names that change what a later step executes. None may be written to the
// command files (the vetted blocks write the names listed in VETTED_STEPS).
const DANGEROUS_ENV_NAME =
  /(^|[^A-Za-z0-9_])(BASH_ENV|ENV|PATH|NODE_OPTIONS|NODE_PATH|LD_[A-Z_]+|DYLD_[A-Z_]+)\s*=/;

/**
 * Join `\` continuations so one command is one line; drop comment lines.
 * Physical lines are classified first, as bash reads them: a line whose first
 * non-blank character is `#` is a comment, and a comment never continues onto
 * the next line, whatever it ends with. Only a line that is not a comment and
 * ends in an odd number of backslashes joins the one after it. (A `#` line that
 * is itself the continuation of a command is part of that command, so the
 * joined line stays unlisted and is reported.)
 */
export function logicalLines(text) {
  const lines = [];
  let current = null;
  for (const physical of text.replace(/\r/g, '').split('\n')) {
    const body = physical.trimStart();
    if (current === null && (body.trim() === '' || body.startsWith('#'))) {
      continue;
    }
    const trailing = /\\*$/.exec(body)[0].length;
    const joins = trailing % 2 === 1 && !body.startsWith('#');
    const piece = joins ? body.slice(0, -1).trimEnd() : body;
    current = current === null ? piece : `${current} ${piece}`;
    if (!joins) {
      lines.push(current.trim());
      current = null;
    }
  }
  if (current !== null) lines.push(current.trim());
  return lines.filter((line) => line !== '');
}

const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (value === undefined ? undefined : String(value));

/**
 * Every reference to `secrets` anywhere under `value`: `{ path, value, key }`.
 * A string counts when it holds an expression (`${{`) and mentions `secrets`
 * anywhere in any case, or when it is an `if` condition (a bare expression)
 * that does. The WHOLE string is tested, not the text up to the first `}}`:
 * `${{ '}}' || secrets.X }}` would otherwise hide the reference in a string
 * literal. Over-matching is safe: a string that merely says "secrets" next to
 * an expression is reported and has to be reworded. A mapping key counts when
 * it is `secrets` (`secrets: inherit`) or an expression naming it.
 */
export function secretReferences(value, path = []) {
  const found = [];
  const mentions = (s) => /secrets/i.test(s);
  const expression = (s) => s.includes('${{') && mentions(s);
  const walk = (node, at) => {
    if (typeof node === 'string') {
      const bare = at.at(-1) === 'if';
      if (expression(node) || (bare && mentions(node))) {
        found.push({ path: at, value: node, key: false });
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, [...at, index]));
    } else if (isObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        if (/^secrets$/i.test(key) || expression(key)) {
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

/**
 * The VETTED_STEPS entry a step is, or undefined: the exact `run` text (trailing
 * newlines aside), only the keys name / id / if / env / run, and only the env
 * names the entry lists. A step that is not one is checked line by line.
 */
function vettedStep(step) {
  if (step.run === undefined) return undefined;
  const run = step.run.replace(/\n+$/, '');
  return VETTED_STEPS.find(
    (entry) =>
      entry.run === run &&
      Object.keys(step.raw).every((key) => SECRET_STEP_KEYS.has(key)) &&
      Object.keys(step.env).every((name) => entry.env.includes(name)),
  );
}

/**
 * `defaults:` of the workflow or of a job. Neither may set a working
 * directory (the signing line is anchored to $GITHUB_WORKSPACE, and a changed
 * directory moves every relative path). A job that holds a secret must set
 * the shell to exactly `bash`, so that no step of it runs under a shell
 * the allow-list does not describe (Windows defaults to PowerShell); at
 * workflow level the shell is absent or exactly `bash`.
 */
function defaultsProblems(defaults, requireShell) {
  const problems = [];
  if (defaults !== undefined && !isObject(defaults)) {
    return ['is not a mapping'];
  }
  const keys = Object.keys(defaults ?? {});
  if (keys.some((key) => key !== 'run')) {
    problems.push(`may only set run (got ${keys.join(', ')})`);
  }
  const run = defaults?.run;
  if (run !== undefined && !isObject(run)) problems.push('run is not a mapping');
  const runKeys = isObject(run) ? Object.keys(run) : [];
  if (runKeys.includes('working-directory')) {
    problems.push('sets defaults.run.working-directory');
  }
  if (runKeys.some((key) => key !== 'shell' && key !== 'working-directory')) {
    problems.push(`defaults.run may only set shell (got ${runKeys.join(', ')})`);
  }
  const shell = isObject(run) ? run.shell : undefined;
  if (shell !== undefined && shell !== 'bash') {
    problems.push(`sets its default shell to ${JSON.stringify(shell)}, not exactly bash`);
  }
  if (requireShell && shell !== 'bash') {
    problems.push('does not set defaults.run.shell to exactly bash');
  }
  return problems;
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
  for (const problem of defaultsProblems(workflow.top.defaults, false)) {
    add(`workflow-level defaults: ${problem}`);
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
      for (const problem of defaultsProblems(job.head.defaults, true)) {
        add(`${where}: a job with secrets: defaults ${problem}`);
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
        const vetted = vettedStep(step);
        // A step that holds a secret is held to its allow-list above; every
        // other step of the job is held to the rules below.
        if (
          step.run !== undefined &&
          !vetted &&
          secretReferences(step.raw).length === 0
        ) {
          const joined = commands.join('\n');
          if (
            BUILD_OR_INSTALL.test(joined) ||
            /\btauri\s+(build|dev|bundle|init|add)\b/.test(joined)
          ) {
            add(`${at}: a step in a job with secrets builds, installs or downloads code`);
          }
          if (RUNS_OTHER_CODE.test(joined)) {
            add(`${at}: a step in a job with secrets runs an interpreter or code that is not in its text`);
          }
          if (COMMAND_FILES.test(step.run) || /GITHUB_\W*E\W*N\W*V/.test(step.run)) {
            add(`${at}: a step in a job with secrets writes to the workflow command files (GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, GITHUB_STATE) outside the vetted blocks`);
          }
          if (DANGEROUS_ENV_NAME.test(step.run)) {
            add(`${at}: a step in a job with secrets sets BASH_ENV, NODE_OPTIONS, PATH, LD_*, DYLD_* or ENV`);
          }
        }
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
        const keys = Object.keys(cleanup?.raw ?? {});
        if (
          cleanup === undefined ||
          cleanup.if !== 'always()' ||
          cleanup.uses !== undefined ||
          keys.some((key) => !CLEANUP_KEYS.has(key)) ||
          cleanup.run === undefined ||
          cleanup.run.replace(/\n+$/, '') !== CLEANUP_STEP.run
        ) {
          add(`${where}: the last step must be the exact always() cleanup that deletes the keychain and removes the installed CLI (only name, if: always() and the vetted run)`);
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

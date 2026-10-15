import { spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

const ROOT_PREFIX = 'smrt-run-';
const SIGNAL_GRACE_MILLISECONDS = 500;

function usage(message) {
  console.error(`::error::${message}`);
  process.exitCode = 2;
}

function isOwnedChild(base, candidate) {
  const relativePath = relative(base, candidate);
  return dirname(candidate) === base
    && relativePath.startsWith(ROOT_PREFIX)
    && !relativePath.includes(sep)
    && !relativePath.startsWith('..');
}

async function listLeftovers(root, managedDirectories) {
  const rootDetails = await lstat(root);
  if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
    throw new Error(`refusing to inspect an unowned cleanup root: ${root}`);
  }
  const leftovers = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(directory, entry.name);
      const details = await lstat(entryPath);
      const displayPath = relative(root, entryPath);
      if (managedDirectories.has(entryPath)) {
        if (!details.isDirectory() || details.isSymbolicLink()) {
          throw new Error(`managed tool cache is not an owned directory: ${entryPath}`);
        }
        continue;
      }
      leftovers.push(details.isSymbolicLink() ? `${displayPath} (symlink)` : displayPath);
      // A link may point at shared data. Report it, but never traverse it.
      if (details.isDirectory() && !details.isSymbolicLink()) await visit(entryPath);
    }
  }
  await visit(root);
  return leftovers;
}

function run(command, environment) {
  let child;
  const completed = new Promise((resolveRun) => {
    child = spawn(command[0], command.slice(1), {
      detached: true,
      env: environment,
      stdio: 'inherit',
    });
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolveRun(result);
      }
    };
    child.once('error', (startupError) => settle({ code: 1, startupError }));
    child.once('close', (code, signal) => settle({ code: code ?? 1, signal }));
  });
  return { child, completed };
}

async function main() {
  const separator = process.argv.indexOf('--');
  if (separator === -1 || separator === process.argv.length - 1) {
    usage('Expected the test command after --');
    return;
  }
  if (!process.env.TMPDIR) {
    usage('TMPDIR must name a short, writable directory outside /tmp');
    return;
  }

  let base;
  try {
    base = await realpath(process.env.TMPDIR);
  } catch (error) {
    usage(`TMPDIR is not an existing directory: ${error.message}`);
    return;
  }
  if (base === '/tmp' || base.startsWith('/tmp/')) {
    usage('TMPDIR must be a short writable directory outside /tmp');
    return;
  }

  const runRoot = await mkdtemp(join(base, ROOT_PREFIX));
  if (!isOwnedChild(base, runRoot)) throw new Error(`Refusing unexpected cleanup root: ${runRoot}`);
  const root = join(runRoot, 'tmp');
  const compileCache = join(runRoot, 'node-compile-cache');
  // Jiti has no cache-directory environment setting: JITI_FS_CACHE is a
  // boolean switch. Its enabled default writes this exact os.tmpdir()/jiti
  // path, which resolves beneath our injected TMPDIR.
  const jitiCache = join(root, 'jiti');
  const tsxCache = join(root, `tsx-${process.geteuid?.() ?? userInfo().username}`);
  await mkdir(root);
  await Promise.all([mkdir(compileCache), mkdir(jitiCache), mkdir(tsxCache)]);
  const managedFixtureDirectories = new Set([jitiCache, tsxCache]);

  let child;
  let interruptedBy;
  let safeToCleanup = true;
  let forceKillCompleted;
  const signals = ['SIGINT', 'SIGTERM'];
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') {
        safeToCleanup = false;
        console.error(`::error::Could not stop the owned test process group: ${error.message}`);
      }
    }
  };
  const forwardSignal = (signal) => {
    interruptedBy ??= signal;
    if (child?.pid) {
      signalGroup(signal);
      forceKillCompleted ??= new Promise((resolveForceKill) => {
        setTimeout(() => {
          signalGroup('SIGKILL');
          resolveForceKill();
        }, SIGNAL_GRACE_MILLISECONDS);
      });
    }
  };
  const handlers = new Map(signals.map((signal) => [signal, () => forwardSignal(signal)]));
  for (const [signal, handler] of handlers) process.once(signal, handler);

  let outcome;
  let leftovers = [];
  let cleanupError;
  try {
    const execution = run(process.argv.slice(separator + 1), {
      ...process.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      CI_TEST_TMPDIR: root,
      NODE_COMPILE_CACHE: compileCache,
    });
    child = execution.child;
    // A signal can arrive in the small window between installing handlers and
    // spawning the command. Apply the recorded signal once the group exists.
    if (interruptedBy) forwardSignal(interruptedBy);
    outcome = await execution.completed;
    // `close` only confirms the direct child. A test runner may exit on SIGTERM
    // while one of its workers ignores it, so do not inspect or remove the root
    // until the bounded process-group SIGKILL has been delivered.
    if (interruptedBy) {
      await forceKillCompleted;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (outcome.startupError) console.error(`::error::Test command could not start: ${outcome.startupError.message}`);
    console.error(`::notice::Managed tool cache directories: ${compileCache}, ${jitiCache}, ${tsxCache}`);
    leftovers = await listLeftovers(root, managedFixtureDirectories);
    if (leftovers.length > 0) {
      console.error(`::error::Test command left resources in its owned temporary root:\n${leftovers.map((entry) => `  ${entry}`).join('\n')}`);
    }
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    try {
      if (!safeToCleanup) {
        throw new Error(`preserving temporary root until its process group can be stopped: ${runRoot}`);
      }
      const details = await lstat(runRoot);
      if (!details.isDirectory() || details.isSymbolicLink() || !isOwnedChild(base, runRoot)) {
        throw new Error(`refusing to remove an unowned cleanup root: ${runRoot}`);
      }
      // Only the exact pre-created Jiti and tsx caches are excluded from fixture reporting.
      // Every other path beneath root remains a test artifact and is reported.
      await Promise.all([
        rm(jitiCache, { recursive: true, force: true, maxRetries: 2 }),
        rm(tsxCache, { recursive: true, force: true, maxRetries: 2 }),
      ]);
      await rm(compileCache, { recursive: true, force: true, maxRetries: 2 });
      await rm(root, { recursive: true, force: true, maxRetries: 2 });
      await rm(runRoot, { recursive: true, force: true, maxRetries: 2 });
    } catch (error) {
      cleanupError = error;
      console.error(`::error::Could not remove owned temporary root ${runRoot}: ${error.message}`);
    }
  }

  if (interruptedBy) process.exitCode = 128 + (interruptedBy === 'SIGINT' ? 2 : 15);
  else if (cleanupError || leftovers.length > 0) process.exitCode = outcome?.code && outcome.code !== 0 ? outcome.code : 1;
  else process.exitCode = outcome?.code ?? 1;
}

await main();

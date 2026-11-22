// `build/index.js`, published as `@happyvertical/smrt-app-shell/start` and run
// by `smrt-app-shell` and `node build` (#5494, #5546). Source of the file
// `svelte.config.js` writes over adapter-node's entry (which it keeps as
// `server-start.js`: the listener, `PORT`/`HOST`/`SOCKET_PATH`, socket
// activation).
//
// Importing starts listening. This entry owns the SIGTERM/SIGINT shutdown, on
// top of the two pieces an embedding host uses (`./embed`): the listener is
// adapter-node's, closed as the drain's `stopAccepting` step, and the drain
// ends streams, waits for imports and closes the apps; then the process exits.
// `SMRT_APP_SHELL_PREDRAIN_MS` (whole milliseconds, default 0) keeps the
// listener open and serving for that long after the signal, before the drain
// starts, so a load balancer can stop sending traffic first.
process.env.BODY_SIZE_LIMIT ??= '__IMPORT_MAX_BYTES__';

const signals = ['SIGTERM', 'SIGINT'];

const predrain = process.env.SMRT_APP_SHELL_PREDRAIN_MS ?? '';
const predrainMs = predrain === '' ? 0 : Number(predrain);
if (!Number.isInteger(predrainMs) || predrainMs < 0) {
  throw new RangeError(
    `SMRT_APP_SHELL_PREDRAIN_MS must be a non-negative whole number of milliseconds (got ${JSON.stringify(predrain)})`,
  );
}

// The handler first (one module instance, shared with server-start.js), then
// the listener.
const { drain } = await import('./embed.js');

// Only what adapter-node itself installs is taken over below: snapshot after
// the shell initialised (its own signal handlers stay), before the listener.
const before = new Map(signals.map((s) => [s, new Set(process.listeners(s))]));
// adapter-node announces `sveltekit:shutdown` once its listener closed and
// every accepted request ended, whoever asked it to (a signal, or its own idle
// timeout under socket activation): listen from the start, not from the step.
const listenerStopped = new Promise((resolve) =>
  process.once('sveltekit:shutdown', () => resolve()),
);
await import('./server-start.js');

// adapter-node's own SIGTERM/SIGINT handler closes the listener the moment the
// signal arrives. Take it over: keep it as the `stopAccepting` step.
const adapterStops = new Set();
for (const signal of signals) {
  for (const listener of process.listeners(signal)) {
    if (before.get(signal).has(listener)) continue;
    process.off(signal, listener);
    adapterStops.add(listener);
  }
}
if (adapterStops.size === 0) {
  throw new Error(
    'smrt-app-shell: adapter-node installed no signal handler to take over',
  );
}
const stopListener = (reason) => {
  for (const stop of adapterStops) stop(reason);
  return listenerStopped;
};

let running;
function shutdown(reason) {
  running ??= (async () => {
    if (predrainMs > 0) {
      process.stderr.write(
        `[shutdown] ${reason}: still serving for ${predrainMs} ms before the drain\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, predrainMs));
    }
    const result = await drain({
      reason,
      stopAccepting: () => stopListener(reason),
    });
    process.exit(result.code);
  })();
  return running;
}
for (const signal of signals) process.on(signal, () => void shutdown(signal));

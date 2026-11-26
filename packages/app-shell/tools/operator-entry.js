// `build/operator.js`, run by `smrt-app-shell <command>` (#5193). Source of the
// file `svelte.config.js` writes next to the adapter-node output.
//
// Runs ONE operator command on the host and exits: it initialises the shell the
// way `./embed` does (same environment, same database, listening on nothing),
// runs the command inside the server bundle (`src/lib/server/operator.ts`),
// drains the shell and exits with the command's code. The command acts on an
// owner's app only after the shell has verified that user is the tenant's
// owner; this file passes the command line through and nothing else.
//
// SMRT_APP_SHELL_OPERATOR keeps this process from starting its own background
// job runner beside the server's.
process.env.SMRT_APP_SHELL_OPERATOR = '1';
process.env.BODY_SIZE_LIMIT ??= '__IMPORT_MAX_BYTES__';

const argv = process.argv.slice(2);
let code = 1;
try {
  await import('./handler.js');
  const slot = globalThis[Symbol.for('@happyvertical/smrt-app-shell/embed')];
  if (!slot || typeof slot.operator?.run !== 'function') {
    throw new Error(
      'the shell did not publish its operator commands (is this a production build?)',
    );
  }
  code = await slot.operator.run(argv);
  await slot.drain();
} catch (error) {
  process.stderr.write(
    `smrt-app-shell: ${error instanceof Error ? error.message : String(error)}\n`,
  );
}
process.exit(code);

// `build/embed.js`, published as `@happyvertical/smrt-app-shell/embed` (#5546).
// Source of the file `svelte.config.js` writes next to the adapter-node output.
//
// For a host that owns its HTTP listener, its signals and its exit: importing
// this initialises the shell (the SvelteKit server and the runtime) WITHOUT
// listening, and exports the request handler and the drain.
//
//   import { handler, drain } from '@happyvertical/smrt-app-shell/embed';
//   const server = http.createServer(handler);   // or app.use(handler)
//   ...
//   await drain();                                // then close your listener, exit
//
// `drain` never closes a listener, installs a signal handler or exits.
// BODY_SIZE_LIMIT (imports) is raised here, before the handler reads it, unless
// the host set its own.
process.env.BODY_SIZE_LIMIT ??= '__IMPORT_MAX_BYTES__';
const { handler: shell } = await import('./handler.js');
// `hooks.server.ts` publishes the drain from inside the server bundle (a
// separate module instance from this file) under this registry symbol.
const slot = globalThis[Symbol.for('@happyvertical/smrt-app-shell/embed')];
if (!slot || typeof slot.drain !== 'function') {
  throw new Error(
    '@happyvertical/smrt-app-shell/embed: the shell did not publish its drain (is this a production build?)',
  );
}

/**
 * Node request listener and connect/express middleware. The shell serves every
 * path (static files, then the app), so `next` is only a fallback for a
 * request nothing answered.
 */
export const handler = (req, res, next) =>
  shell(
    req,
    res,
    next ??
      (() => {
        res.statusCode = 404;
        res.end();
      }),
  );

/** The ordered drain; the same promise on every call. */
export const drain = slot.drain;

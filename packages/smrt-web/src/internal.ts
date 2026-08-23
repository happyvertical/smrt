/** Internal coordination state shared by the smrt-web runtime modules. */

/**
 * TanStack transactions resolve with an opaque transaction object rather than
 * the value returned by the REST mutation handler. Keep the latter beside the
 * public collection handle so WebMCP can return the server's canonical row
 * without exposing engine internals.
 */
export const persistedMutationResults = new WeakMap<
  object,
  Map<string, unknown>
>();

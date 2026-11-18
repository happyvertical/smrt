/**
 * The scaffold's placeholder failure (#5158).
 *
 * Every kernel function exists from the first pull request so the later ones
 * can be written against fixed signatures. Until its owner fills one in, it
 * throws this error rather than returning a guess.
 */

/** Thrown by a kernel function whose implementation has not landed. */
export class TransportNotImplementedError extends Error {
  /** `transport.<name>`, for example `transport.executeOperation`. */
  readonly feature: string;

  constructor(name: string, owner: string) {
    super(
      `transport.${name}() is not implemented in K0 (the transport kernel scaffold). ` +
        `It lands with ${owner}; no transport may call it before then.`,
    );
    this.name = 'TransportNotImplementedError';
    this.feature = `transport.${name}`;
  }
}

/**
 * Throw {@link TransportNotImplementedError}.
 *
 * @param name - The exported function's name.
 * @param owner - The pull request that implements it, as named in the design.
 */
export function notImplemented(name: string, owner: string): never {
  throw new TransportNotImplementedError(name, owner);
}

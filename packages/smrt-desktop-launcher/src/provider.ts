/**
 * The launcher's injected provider interface.
 *
 * The launcher core owns diagnostics, trust checks and the stdio lifecycle. It
 * owns no knowledge of how a product is installed, how its instance is started
 * or where its credential is kept. Those three concerns are the three methods
 * of {@link LauncherProvider}; the desktop supervisor, runtime bundler and
 * credential custody (#4663) each satisfy one.
 *
 * @packageDocumentation
 */

/** Calling context passed to every provider method. */
export interface ProviderContext {
  /**
   * Aborted when the launcher is shutting down (SIGTERM/SIGINT, stdin close)
   * or the method exceeded its time budget. Providers should stop promptly.
   */
  readonly signal: AbortSignal;
}

/**
 * The installed product and its bundled runtime. Everything here is data the
 * provider vouches for; the launcher still verifies the filesystem facts
 * (see {@link InstalledRuntime.root}) before it executes anything.
 */
export interface InstalledRuntime {
  /**
   * Version of the provider contract this value follows. The launcher refuses
   * a version outside `supportedContracts` (default `[1]`) with the
   * `unsupported_contract` diagnostic.
   */
  readonly contract: number;
  /** The product identity. Must equal the `productId` the launcher was built for. */
  readonly productId: string;
  /**
   * Absolute path of the trusted installed-product root. The provider vouches
   * for this directory. {@link nodePath} and {@link bridgePath} must resolve
   * inside it without passing through a symlink.
   */
  readonly root: string;
  /** Absolute path of the bundled Node executable. Never found on `PATH`. */
  readonly nodePath: string;
  /** Absolute path of the bridge entry script (`smrt-mcp-bridge`). */
  readonly bridgePath: string;
  /**
   * Route probed on the instance origin before the credential is handed over.
   * Same form as `healthRoute` in the sidecar manifest: one leading slash,
   * unreserved characters only, no query, fragment or dot segments.
   */
  readonly healthRoute: string;
  /**
   * Uppercase prefix of the bridge's configuration environment
   * (`<PREFIX>_SERVER_URL`, `<PREFIX>_TOKEN`).
   */
  readonly envPrefix: string;
  /** Same-server MCP endpoint path. Defaults to `/api/mcp`. */
  readonly mcpPath?: string;
  /** MCP server identity the bridge advertises. Optional. */
  readonly serverName?: string;
  readonly serverVersion?: string;
}

/** A running local instance, as reported by the supervisor rendezvous. */
export interface InstanceEndpoint {
  /**
   * Current loopback origin, exactly `http://<127.0.0.1|[::1]|localhost>:<port>`
   * with no path, credentials, query or fragment.
   */
  readonly origin: string;
}

/**
 * An owner-issued credential for one launch.
 *
 * The launcher passes `token` to the bridge only through the bridge's
 * environment, and never to argv, files, logs or its own stdout/stderr.
 */
export interface LauncherCredential {
  readonly token: string;
  /**
   * Called once after the bridge has been started (or the launch failed), so
   * custody can drop a single-use handoff. Its failure is ignored.
   */
  release?(): void | Promise<void>;
}

/**
 * The launcher's whole view of the desktop shell. Implementations map their
 * published interfaces onto these methods; see the package README for the
 * mapping table.
 *
 * Every method either resolves, or rejects with {@link LauncherProviderError}
 * carrying one of the documented codes. Any other rejection is reported as an
 * internal error, and its message is never printed.
 */
export interface LauncherProvider {
  /**
   * Resolve the intended installed product and its bundled Node and bridge.
   * Reject with `missing_install` when the product is not installed.
   */
  resolveInstall(
    request: { readonly productId: string },
    context: ProviderContext,
  ): Promise<InstalledRuntime>;

  /**
   * Locate the running local instance, or start it, and report its current
   * loopback origin. Reject with `stale_instance` when the rendezvous exists
   * but the instance is gone or does not match, and with `unexpected_endpoint`
   * when the rendezvous reports an origin the product does not own.
   */
  connectInstance(
    install: InstalledRuntime,
    context: ProviderContext,
  ): Promise<InstanceEndpoint>;

  /**
   * Hand over the owner-issued credential for this instance. Reject with
   * `credential_unavailable` when custody holds none (not signed in, not
   * minted) and with `credential_invalid` when custody knows it is revoked,
   * expired or minted for another instance.
   */
  acquireCredential(
    install: InstalledRuntime,
    instance: InstanceEndpoint,
    context: ProviderContext,
  ): Promise<LauncherCredential>;
}

/** Failure codes a provider may raise. */
export const PROVIDER_FAILURE_CODES = [
  'missing_install',
  'unsupported_contract',
  'stale_instance',
  'credential_unavailable',
  'credential_invalid',
  'unexpected_endpoint',
] as const;

export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

const PROVIDER_ERROR_BRAND = Symbol.for(
  'happyvertical.smrt-desktop-launcher.provider-error',
);

/**
 * A provider failure. Only {@link LauncherProviderError.code} is consulted;
 * the message is for the provider's own logs and is never printed by the
 * launcher, so it cannot leak a credential into a diagnostic.
 */
export class LauncherProviderError extends Error {
  override readonly name = 'LauncherProviderError';
  readonly [PROVIDER_ERROR_BRAND] = true;

  constructor(
    readonly code: ProviderFailureCode,
    message?: string,
  ) {
    super(message ?? code);
  }

  /** Recognise a provider failure across duplicated copies of this package. */
  static is(value: unknown): value is LauncherProviderError {
    return (
      typeof value === 'object' &&
      value !== null &&
      (value as Record<symbol, unknown>)[PROVIDER_ERROR_BRAND] === true &&
      (PROVIDER_FAILURE_CODES as readonly unknown[]).includes(
        (value as { code?: unknown }).code,
      )
    );
  }
}

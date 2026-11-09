/**
 * Client side of the relay-held primary-writer lease (#4805).
 *
 * {@link VaultLeaseClient} speaks the relay's `/v1/lease` routes through an
 * injected, already-signing transport (the vault relay client owns signing
 * and HTTP). {@link VaultLeaseKeeper} holds the lease while the local app
 * writes against a vault account: it acquires with the location's base
 * sequence, renews ahead of expiry, and degrades to read-only when the lease
 * is lost or the account moved on (`must-restore`).
 *
 * Expiry is judged on this process's monotonic clock from the moment the
 * request was sent, using the lifetime the relay granted (`ttlMs`), never by
 * comparing the relay's `expiresAt` with the local wall clock.
 */

import { vaultSyncFor, writeVaultSyncRecord } from './vault-sync-state.js';

/** One relay response, already parsed. */
export interface VaultRelayResponse {
  status: number;
  body: unknown;
}

/** Signed request seam supplied by the vault relay client. */
export interface VaultRelayTransport {
  send(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<VaultRelayResponse>;
}

/** Structured lease outcomes, matching the relay's error codes. */
export type VaultLeaseErrorCode =
  | 'must_restore_first'
  | 'lease_held'
  | 'publish_in_progress'
  | 'lease_lost'
  | 'vault_lease_lost'
  | 'account_superseded'
  | 'relay_error';

export class VaultLeaseError extends Error {
  readonly code: VaultLeaseErrorCode;
  readonly detail: Record<string, unknown>;

  constructor(code: VaultLeaseErrorCode, detail: Record<string, unknown> = {}) {
    super(
      code === 'must_restore_first'
        ? 'This device is behind the vault account; restore the latest snapshot before writing.'
        : code === 'lease_held'
          ? 'Another device is writing to this vault account.'
          : code === 'publish_in_progress'
            ? 'Another device is publishing a snapshot; try again shortly.'
            : code === 'lease_lost' || code === 'vault_lease_lost'
              ? 'This device no longer holds the vault writer lease; it is read-only until restored.'
              : code === 'account_superseded'
                ? 'The relay reports that this vault account was replaced by a new one; this device does not back up to it.'
                : 'The vault relay could not be reached or answered unexpectedly.',
    );
    this.name = 'VaultLeaseError';
    this.code = code;
    this.detail = detail;
  }
}

/** A granted or renewed lease. */
export interface VaultLeaseGrant {
  fencingToken: number;
  /** Lifetime granted by the relay, in milliseconds. */
  ttlMs: number;
  headSequence: number;
}

/** Public lease state of the account. */
export interface VaultLeaseStatus {
  holder: string | null;
  headSequence: number;
  latestCommittedSequence: number;
  headIsHole: boolean;
}

const KNOWN_REFUSALS = new Set<string>([
  'must_restore_first',
  'lease_held',
  'publish_in_progress',
  'lease_lost',
  'account_superseded',
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeInteger(value: unknown, minimum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new VaultLeaseError('relay_error');
  }
  return value;
}

function refusal(response: VaultRelayResponse): VaultLeaseError {
  const body = record(response.body);
  const { error, ...detail } = body;
  if (
    response.status === 409 &&
    typeof error === 'string' &&
    KNOWN_REFUSALS.has(error)
  ) {
    return new VaultLeaseError(error as VaultLeaseErrorCode, detail);
  }
  return new VaultLeaseError('relay_error', { status: response.status });
}

function grant(response: VaultRelayResponse): VaultLeaseGrant {
  if (response.status !== 200) throw refusal(response);
  const body = record(response.body);
  return {
    fencingToken: safeInteger(body.fencingToken, 1),
    ttlMs: safeInteger(body.ttlMs, 1),
    headSequence: safeInteger(body.headSequence, 0),
  };
}

/** Thin typed client for the relay's lease routes. */
export class VaultLeaseClient {
  private readonly transport: VaultRelayTransport;

  constructor(transport: VaultRelayTransport) {
    this.transport = transport;
  }

  async status(): Promise<VaultLeaseStatus> {
    const response = await this.transport.send('GET', '/v1/lease');
    if (response.status !== 200) throw refusal(response);
    const body = record(response.body);
    return {
      holder: typeof body.holder === 'string' ? body.holder : null,
      headSequence: safeInteger(body.headSequence, 0),
      latestCommittedSequence: safeInteger(body.latestCommittedSequence, 0),
      headIsHole: body.headIsHole === true,
    };
  }

  async acquire(
    baseSequence: number,
    ttlSeconds?: number,
  ): Promise<VaultLeaseGrant> {
    return grant(
      await this.transport.send('POST', '/v1/lease/acquire', {
        baseSequence,
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      }),
    );
  }

  async renew(
    fencingToken: number,
    ttlSeconds?: number,
  ): Promise<VaultLeaseGrant> {
    return grant(
      await this.transport.send('POST', '/v1/lease/renew', {
        fencingToken,
        ...(ttlSeconds !== undefined ? { ttlSeconds } : {}),
      }),
    );
  }

  async release(fencingToken: number): Promise<void> {
    const response = await this.transport.send('POST', '/v1/lease/release', {
      fencingToken,
    });
    if (response.status !== 204) throw refusal(response);
  }
}

/** What the keeper currently allows. Only `held` is writable. */
export type VaultLeaseState =
  | 'idle'
  | 'held'
  | 'must-restore'
  | 'held-elsewhere'
  | 'lost'
  | 'superseded'
  | 'unavailable'
  | 'stopped';

/** Timer seam so tests drive renewal deterministically. */
export interface VaultLeaseTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface VaultLeaseKeeperOptions {
  client: VaultLeaseClient;
  /** Private state root holding `vault-sync.json`. */
  stateRoot: string;
  accountId: string;
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  monotonicNow?: () => number;
  timers?: VaultLeaseTimers;
  /** Renew after this fraction of the granted lifetime (default 1/3). */
  renewFraction?: number;
  /** Treat the lease as lost this long before it lapses (default 5 s). */
  safetyMarginMs?: number;
  /** Called on every state change, for a visible read-only indicator. */
  onChange?(state: VaultLeaseState, error?: VaultLeaseError): void;
}

const defaultTimers: VaultLeaseTimers = {
  set(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return handle;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Keeps the primary-writer lease for the local app and gates writes on it.
 */
export class VaultLeaseKeeper {
  private readonly options: VaultLeaseKeeperOptions;
  private readonly now: () => number;
  private readonly timers: VaultLeaseTimers;
  private currentState: VaultLeaseState = 'idle';
  private token: number | null = null;
  private deadline = 0;
  private timer: unknown = null;

  constructor(options: VaultLeaseKeeperOptions) {
    this.options = options;
    this.now = options.monotonicNow ?? (() => performance.now());
    this.timers = options.timers ?? defaultTimers;
  }

  get state(): VaultLeaseState {
    if (this.currentState === 'held' && this.now() >= this.deadline) {
      this.transition('lost', new VaultLeaseError('vault_lease_lost'));
    }
    return this.currentState;
  }

  /** The token to send with publishes; `null` unless writable. */
  get fencingToken(): number | null {
    return this.state === 'held' ? this.token : null;
  }

  /** True only while the lease is held and not about to lapse. */
  writable(): boolean {
    return this.state === 'held';
  }

  /** Throw a structured `vault_lease_lost` error unless writable. */
  assertWritable(): void {
    if (!this.writable()) {
      throw new VaultLeaseError('vault_lease_lost', {
        state: this.currentState,
      });
    }
  }

  private transition(state: VaultLeaseState, error?: VaultLeaseError): void {
    if (state !== 'held') this.token = null;
    if (state === this.currentState) return;
    this.currentState = state;
    this.options.onChange?.(state, error);
  }

  private accept(sentAt: number, granted: VaultLeaseGrant): void {
    const margin = this.options.safetyMarginMs ?? 5_000;
    this.token = granted.fencingToken;
    this.deadline = sentAt + granted.ttlMs - margin;
    this.transition('held');
    const fraction = this.options.renewFraction ?? 1 / 3;
    this.schedule(Math.max(1_000, Math.floor(granted.ttlMs * fraction)));
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.renew();
    }, delayMs);
  }

  private fail(error: unknown): void {
    const lease =
      error instanceof VaultLeaseError
        ? error
        : new VaultLeaseError('relay_error');
    switch (lease.code) {
      case 'must_restore_first':
        this.transition('must-restore', lease);
        return;
      case 'lease_held':
      case 'publish_in_progress':
        this.transition('held-elsewhere', lease);
        return;
      case 'lease_lost':
      case 'vault_lease_lost':
        this.transition('lost', lease);
        return;
      case 'account_superseded':
        // Not retried: the account was replaced, so this device must follow
        // the new one (the host decides which account it follows).
        this.transition('superseded', lease);
        return;
      default:
        this.transition('unavailable', lease);
    }
  }

  /**
   * Acquire with this location's base sequence. Marks local writes pending
   * once held, because the app may write from then on until a publish.
   */
  async start(): Promise<VaultLeaseState> {
    const sync = vaultSyncFor(this.options.stateRoot, this.options.accountId);
    const sentAt = this.now();
    let granted: VaultLeaseGrant;
    try {
      granted = await this.options.client.acquire(sync.baseSequence);
    } catch (error) {
      this.fail(error);
      return this.currentState;
    }
    try {
      // The downgrade floor only ever rises from sequences known to be
      // committed: ones this location published or restored (recorded by
      // `recordPublished` and by restore-latest). A granted `headSequence`
      // can be a hole (an upload that never committed, which the relay lets a
      // device at the latest committed sequence acquire past) or a number a
      // hostile relay chose; raising the floor to it would make the real
      // latest snapshot look like a downgrade at the next restore.
      writeVaultSyncRecord(this.options.stateRoot, {
        ...sync,
        localWritesPending: true,
      });
    } catch (error) {
      // Never hold a lease the app cannot account for.
      await this.options.client
        .release(granted.fencingToken)
        .catch(() => undefined);
      throw error;
    }
    this.accept(sentAt, granted);
    return this.currentState;
  }

  /** Renew now. Network failures keep the lease until its local deadline. */
  async renew(): Promise<VaultLeaseState> {
    if (this.currentState !== 'held' || this.token === null) {
      return this.currentState;
    }
    const sentAt = this.now();
    try {
      this.accept(sentAt, await this.options.client.renew(this.token));
    } catch (error) {
      if (
        error instanceof VaultLeaseError &&
        error.code === 'relay_error' &&
        this.now() < this.deadline
      ) {
        this.schedule(1_000);
        return this.currentState;
      }
      this.fail(error);
    }
    return this.state;
  }

  /**
   * Record a snapshot this device published under the lease: the location
   * is now at `sequence` with nothing unpublished.
   */
  recordPublished(sequence: number): void {
    const sync = vaultSyncFor(this.options.stateRoot, this.options.accountId);
    if (!Number.isSafeInteger(sequence) || sequence <= sync.baseSequence) {
      throw new Error('A published sequence must advance the vault position.');
    }
    writeVaultSyncRecord(this.options.stateRoot, {
      accountId: this.options.accountId,
      baseSequence: sequence,
      highestSeenSequence: Math.max(sync.highestSeenSequence, sequence),
      localWritesPending: false,
    });
  }

  /** Stop renewing and release the lease if held. */
  async stop(): Promise<void> {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const token = this.token;
    this.transition('stopped');
    if (token !== null) {
      await this.options.client.release(token).catch(() => undefined);
    }
  }
}

/**
 * Primary-writer lease decisions (#4805). The relay maps these results to
 * HTTP; every state change is a single conditional statement in
 * {@link VaultRelayLeaseStore}. Expiry uses the relay clock only.
 */
import type { LeaseGrant, VaultRelayLeaseStore } from './lease-store.js';

/** Smallest lease a client may request, in milliseconds. */
export const MIN_LEASE_TTL_MS = 30_000;

/** Why a lease or publish request was refused. */
export type LeaseRefusal =
  | {
      error: 'must_restore_first';
      headSequence: number;
      latestSequence: number;
    }
  | { error: 'lease_held'; holder: string; expiresAt: number }
  | { error: 'publish_in_progress'; headSequence: number }
  | { error: 'lease_lost' };

/** Public lease state. The fencing token is never part of it. */
export interface LeaseStatus {
  holder: string | null;
  expiresAt: number | null;
  headSequence: number;
  latestCommittedSequence: number;
  /** The head's upload never committed; acquire accepts the latest instead. */
  headIsHole: boolean;
}

export type LeaseResult =
  | { ok: true; grant: LeaseGrant }
  | { ok: false; refusal: LeaseRefusal };

export class LeaseService {
  private readonly store: VaultRelayLeaseStore;
  private readonly ttlMs: number;

  constructor(store: VaultRelayLeaseStore, ttlMs: number) {
    this.store = store;
    this.ttlMs = ttlMs;
  }

  /** The granted lifetime: the policy TTL, or a shorter one the client asks. */
  private lifetime(requestedMs: number | undefined): number {
    if (requestedMs === undefined) return this.ttlMs;
    return Math.min(this.ttlMs, Math.max(MIN_LEASE_TTL_MS, requestedMs));
  }

  async status(accountId: string, now: number): Promise<LeaseStatus> {
    await this.store.ensureLease(accountId);
    const lease = await this.store.getLease(accountId);
    const latest = await this.store.latestCommittedSequence(accountId);
    const head = lease?.headSequence ?? latest;
    const headStatus =
      head === 0
        ? 'committed'
        : await this.store.snapshotStatusAt(accountId, head);
    const live =
      lease?.holderDeviceId !== null &&
      lease?.holderDeviceId !== undefined &&
      lease.expiresAt > now;
    return {
      holder: live ? (lease?.holderDeviceId ?? null) : null,
      expiresAt: live ? (lease?.expiresAt ?? null) : null,
      headSequence: head,
      latestCommittedSequence: latest,
      headIsHole: headStatus === null,
    };
  }

  /** Explain a refused acquire or publish from the current row. */
  private async refusal(
    accountId: string,
    deviceId: string,
    now: number,
  ): Promise<LeaseRefusal> {
    const lease = await this.store.getLease(accountId);
    const latest = await this.store.latestCommittedSequence(accountId);
    const head = lease?.headSequence ?? latest;
    if (
      lease?.holderDeviceId &&
      lease.holderDeviceId !== deviceId &&
      lease.expiresAt > now
    ) {
      return {
        error: 'lease_held',
        holder: lease.holderDeviceId,
        expiresAt: lease.expiresAt,
      };
    }
    if ((await this.store.snapshotStatusAt(accountId, head)) === 'pending') {
      return { error: 'publish_in_progress', headSequence: head };
    }
    return {
      error: 'must_restore_first',
      headSequence: head,
      latestSequence: latest,
    };
  }

  async acquire(
    accountId: string,
    deviceId: string,
    baseSequence: number,
    requestedTtlMs: number | undefined,
    now: number,
  ): Promise<LeaseResult> {
    await this.store.ensureLease(accountId);
    const grant = await this.store.acquire(
      accountId,
      deviceId,
      baseSequence,
      now,
      now + this.lifetime(requestedTtlMs),
    );
    if (grant) return { ok: true, grant };
    return { ok: false, refusal: await this.refusal(accountId, deviceId, now) };
  }

  async renew(
    accountId: string,
    deviceId: string,
    fencingToken: number,
    requestedTtlMs: number | undefined,
    now: number,
  ): Promise<LeaseResult> {
    const grant = await this.store.renew(
      accountId,
      deviceId,
      fencingToken,
      now,
      now + this.lifetime(requestedTtlMs),
    );
    if (grant) return { ok: true, grant };
    return { ok: false, refusal: { error: 'lease_lost' } };
  }

  async release(
    accountId: string,
    deviceId: string,
    fencingToken: number,
  ): Promise<void> {
    await this.store.release(accountId, deviceId, fencingToken);
  }

  /**
   * Begin-time admission (advisory; the commit-time head advance enforces).
   * `null` admits the upload.
   */
  async admitUpload(
    accountId: string,
    deviceId: string,
    fencingToken: number,
    sequence: number,
    now: number,
  ): Promise<LeaseRefusal | null> {
    await this.store.ensureLease(accountId);
    if (
      await this.store.holds(accountId, deviceId, fencingToken, sequence, now)
    ) {
      return null;
    }
    // A device that does not hold the lease must restore before writing,
    // whoever holds it now (#4805: one structured refusal for publishes).
    return this.mustRestore(accountId);
  }

  /** The `must_restore_first` answer for a publish that lost its lease. */
  async mustRestore(accountId: string): Promise<LeaseRefusal> {
    const lease = await this.store.getLease(accountId);
    const latest = await this.store.latestCommittedSequence(accountId);
    return {
      error: 'must_restore_first',
      headSequence: lease?.headSequence ?? latest,
      latestSequence: latest,
    };
  }
}

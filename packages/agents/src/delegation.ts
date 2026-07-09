/**
 * Delegation envelope — the immutable principal + bounded depth carried along an
 * agent-orchestration chain (L3 of the learning-agents epic, #1892).
 *
 * When a conversational (orchestrator) agent invokes a worker agent, and that
 * worker in turn invokes a further worker, the whole chain must run as **one**
 * principal — the originating user — and can never widen it. This module is the
 * pure value object that encodes that invariant:
 *
 * - **Principal immutability.** `runAsUserId`, `tenantId`, and the originating
 *   `onBehalfOfUserId` are copied verbatim from parent to child by
 *   {@link deriveDelegationEnvelope}; there is no parameter to change them. A
 *   caller that *requests* a different principal (e.g. a compromised worker
 *   passing `runAsUserId` through the invoke-agent tool) is rejected by
 *   {@link assertPrincipalNotWidened} — the request is honoured only when it
 *   exactly equals the parent principal.
 * - **Bounded depth.** Every derivation increments `depth` and asserts it stays
 *   within {@link MAX_DELEGATION_DEPTH}, so an orchestration chain (or an
 *   accidental invoke-yourself loop) can never recurse without limit.
 *
 * The envelope carries no authority of its own: the actual permission bound is
 * still the originating user's live RBAC, enforced when the worker runs via
 * `executeAsPrincipal` (Postgres RLS, or the catalog assert on RLS-off
 * adapters). The envelope only guarantees *which* principal that is and *how
 * deep* the chain may go.
 *
 * @module
 */

/**
 * Maximum delegation depth for an orchestration chain. The orchestrator's own
 * conversation is depth `0`; the first worker it invokes is depth `1`. A worker
 * may invoke a further worker only while the resulting child depth stays within
 * this ceiling, so a chain is at most `MAX_DELEGATION_DEPTH` workers long.
 */
export const MAX_DELEGATION_DEPTH = 3;

/**
 * The immutable principal + bounded depth carried from an orchestrator to a
 * worker (and along any further delegation). Serializable, so it can travel in a
 * job's args or a DispatchBus payload to a worker running out of process.
 */
export interface DelegationEnvelope {
  /**
   * The user whose live permissions bound the worker's execution. Immutable
   * along the chain — copied verbatim from parent to child.
   */
  runAsUserId: string;
  /** Tenant the principal acts within. Immutable along the chain. */
  tenantId: string | null;
  /**
   * The originating user the whole chain acts **on behalf of** (audited). This
   * is the human who started the conversation; it never changes as delegation
   * deepens, so every action along the chain audits back to the same person.
   */
  onBehalfOfUserId: string;
  /**
   * Current delegation depth. `0` for the orchestrator, `1` for its first
   * worker, and so on — bounded by {@link MAX_DELEGATION_DEPTH}.
   */
  depth: number;
  /**
   * Correlation id linking a worker invocation to the completion dispatch it
   * emits, so the orchestrator can surface the result back into the
   * conversation.
   */
  correlationId: string;
  /**
   * The worker's tool ceiling (its persona's `allowedTools`), carried so a
   * worker that itself runs a tool loop is bounded fail-closed. `undefined`
   * normalizes to "no tools" at `executeAsPrincipal` — it never widens.
   */
  allowedTools?: string[];
}

/**
 * The principal fields a caller may *request* when deriving a child envelope.
 * Any field that is provided must equal the parent's, or
 * {@link assertPrincipalNotWidened} throws — the principal can only ever be
 * inherited, never changed.
 */
export interface RequestedPrincipal {
  runAsUserId?: string;
  tenantId?: string | null;
  onBehalfOfUserId?: string;
}

/**
 * Thrown when a delegation would exceed {@link MAX_DELEGATION_DEPTH}.
 */
export class DelegationDepthExceededError extends Error {
  readonly depth: number;
  readonly maxDepth: number;
  readonly status = 400;

  constructor(depth: number, maxDepth: number) {
    super(
      `Delegation depth ${depth} exceeds the maximum of ${maxDepth}; ` +
        'a worker cannot invoke a further worker beyond this depth.',
    );
    this.name = 'DelegationDepthExceededError';
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

/**
 * Thrown when a delegation would *widen* the principal — i.e. a caller requests
 * a `runAsUserId` / `tenantId` / `onBehalfOfUserId` that differs from the
 * parent's. The principal is immutable along an orchestration chain.
 */
export class PrincipalWideningError extends Error {
  readonly field: keyof RequestedPrincipal;
  readonly status = 403;

  constructor(
    field: keyof RequestedPrincipal,
    expected: unknown,
    got: unknown,
  ) {
    super(
      `Delegation cannot widen the principal: '${String(field)}' is immutable ` +
        `along the chain (bound to ${JSON.stringify(expected)}, ` +
        `refusing ${JSON.stringify(got)}).`,
    );
    this.name = 'PrincipalWideningError';
    this.field = field;
  }
}

/**
 * Assert a delegation depth is within the ceiling.
 *
 * @throws {@link DelegationDepthExceededError} when `depth > maxDepth`.
 */
export function assertWithinDelegationDepth(
  depth: number,
  maxDepth: number = MAX_DELEGATION_DEPTH,
): void {
  if (depth > maxDepth) {
    throw new DelegationDepthExceededError(depth, maxDepth);
  }
}

/**
 * Assert a *requested* principal does not widen the parent's.
 *
 * Each provided field must exactly equal the parent's; a mismatch throws
 * {@link PrincipalWideningError}. Omitted fields are fine — they inherit. This
 * is the defence-in-depth guard for the case where an envelope is reconstructed
 * from an untrusted source (a worker's invoke-agent arguments, a job payload):
 * the principal is only ever accepted when it matches, so it can never expand.
 */
export function assertPrincipalNotWidened(
  parent: Pick<
    DelegationEnvelope,
    'runAsUserId' | 'tenantId' | 'onBehalfOfUserId'
  >,
  requested: RequestedPrincipal,
): void {
  if (
    requested.runAsUserId !== undefined &&
    requested.runAsUserId !== parent.runAsUserId
  ) {
    throw new PrincipalWideningError(
      'runAsUserId',
      parent.runAsUserId,
      requested.runAsUserId,
    );
  }
  if (
    requested.tenantId !== undefined &&
    requested.tenantId !== parent.tenantId
  ) {
    throw new PrincipalWideningError(
      'tenantId',
      parent.tenantId,
      requested.tenantId,
    );
  }
  if (
    requested.onBehalfOfUserId !== undefined &&
    requested.onBehalfOfUserId !== parent.onBehalfOfUserId
  ) {
    throw new PrincipalWideningError(
      'onBehalfOfUserId',
      parent.onBehalfOfUserId,
      requested.onBehalfOfUserId,
    );
  }
}

/**
 * Options for {@link rootDelegationEnvelope}.
 */
export interface RootDelegationEnvelopeOptions {
  /** The principal the orchestrator (and thus the whole chain) runs as. */
  runAsUserId: string;
  /** Tenant the principal acts within. */
  tenantId: string | null;
  /**
   * The originating user the chain acts on behalf of. Defaults to
   * `runAsUserId` when the orchestrator is itself operating directly.
   */
  onBehalfOfUserId?: string;
  /** Correlation id. A fresh UUID is generated when omitted. */
  correlationId?: string;
  /** The orchestrator's tool ceiling, inherited by workers that don't narrow. */
  allowedTools?: string[];
}

/**
 * Build the depth-`0` (orchestrator) envelope that seeds an orchestration chain.
 *
 * The orchestrator's conversation is depth `0`; {@link deriveDelegationEnvelope}
 * produces the depth-`1` envelope for the first worker it invokes.
 */
export function rootDelegationEnvelope(
  options: RootDelegationEnvelopeOptions,
): DelegationEnvelope {
  return {
    runAsUserId: options.runAsUserId,
    tenantId: options.tenantId,
    onBehalfOfUserId: options.onBehalfOfUserId ?? options.runAsUserId,
    depth: 0,
    correlationId: options.correlationId ?? crypto.randomUUID(),
    allowedTools: options.allowedTools,
  };
}

/**
 * Options for {@link deriveDelegationEnvelope}.
 */
export interface DeriveDelegationEnvelopeOptions {
  /** Correlation id for the child invocation. A fresh UUID when omitted. */
  correlationId?: string;
  /**
   * The invoked worker's tool ceiling. When omitted the child carries no tools
   * (fail-closed); it is **not** inherited from the parent so a worker never
   * silently gains the orchestrator's tools.
   */
  allowedTools?: string[];
  /**
   * A principal a caller is *requesting* the child run as. Accepted only when it
   * matches the parent principal exactly (see {@link assertPrincipalNotWidened});
   * otherwise {@link PrincipalWideningError} is thrown. Omit to inherit.
   */
  requestedPrincipal?: RequestedPrincipal;
  /** Depth ceiling override (mainly for tests). */
  maxDepth?: number;
}

/**
 * Derive the child envelope for a worker invoked by the holder of `parent`.
 *
 * The child **inherits the parent's principal verbatim** (`runAsUserId`,
 * `tenantId`, `onBehalfOfUserId`) — there is no way to change it — increments
 * the depth (asserting the ceiling), and carries the invoked worker's own tool
 * ceiling. A `requestedPrincipal` that differs from the parent's is rejected, so
 * a worker can never invoke a further worker under a broader principal.
 *
 * @throws {@link DelegationDepthExceededError} when the child would exceed the depth ceiling.
 * @throws {@link PrincipalWideningError} when a requested principal widens the parent's.
 */
export function deriveDelegationEnvelope(
  parent: DelegationEnvelope,
  options: DeriveDelegationEnvelopeOptions = {},
): DelegationEnvelope {
  const depth = parent.depth + 1;
  assertWithinDelegationDepth(depth, options.maxDepth);
  if (options.requestedPrincipal) {
    assertPrincipalNotWidened(parent, options.requestedPrincipal);
  }
  return {
    // Principal is copied verbatim — immutable along the chain.
    runAsUserId: parent.runAsUserId,
    tenantId: parent.tenantId,
    onBehalfOfUserId: parent.onBehalfOfUserId,
    depth,
    correlationId: options.correlationId ?? crypto.randomUUID(),
    allowedTools: options.allowedTools,
  };
}

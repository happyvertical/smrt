/**
 * Opt-in policy controls for background job creation and dispatch.
 *
 * @remarks
 * These guards harden the background-jobs surface flagged by the S5 audit
 * (#1402):
 *
 * - {@link MAX_JOB_RETRIES} caps the retry count a caller can request so a
 *   misconfigured `.retries(n)` cannot pin a worker on a poison job forever.
 * - {@link assertWithinTenantCreationCap} bounds how many jobs a single tenant
 *   may hold in the queue at once, so one tenant cannot exhaust the shared
 *   worker pool (a cross-tenant denial of service).
 * - {@link isBackgroundEligibleMethod} / {@link backgroundEligible} provide an
 *   opt-in allowlist of methods that may be invoked by the runner. The runner's
 *   dispatch is already bounded to existing prototype methods (no eval / dynamic
 *   import), but a class can further restrict which of its methods are reachable
 *   from a persisted job row. This same marker is intended to be consumed by the
 *   agents package, which dispatches methods through an equivalent path.
 */

/**
 * Hard ceiling on retry attempts a caller may request via `.retries(n)` /
 * `bg(..., { retries })`. Requests above this are clamped (not rejected) so
 * existing callers keep working while the worst case stays bounded.
 */
export const MAX_JOB_RETRIES = 25;

/**
 * Default maximum number of non-terminal (pending/running) jobs a single
 * tenant may hold in the queue at once. Configurable per call; `0` / negative
 * disables the cap.
 */
export const DEFAULT_TENANT_JOB_CAP = 10_000;

/**
 * Clamp a requested retry count to {@link MAX_JOB_RETRIES}.
 *
 * @param requested - The retry count supplied by the caller.
 * @returns A non-negative integer no greater than {@link MAX_JOB_RETRIES}.
 */
export function clampRetries(requested: number): number {
  if (Number.isNaN(requested) || requested < 0) {
    return 0;
  }
  if (requested === Number.POSITIVE_INFINITY) {
    return MAX_JOB_RETRIES;
  }
  return Math.min(Math.floor(requested), MAX_JOB_RETRIES);
}

/**
 * Error thrown when a tenant exceeds its allowed in-flight job count.
 */
export class TenantJobCapExceededError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly cap: number,
    public readonly current: number,
  ) {
    super(
      `Tenant "${tenantId}" has reached its background-job cap ` +
        `(${current}/${cap} in-flight). Refusing to enqueue another job.`,
    );
    this.name = 'TenantJobCapExceededError';
  }
}

/**
 * Throw {@link TenantJobCapExceededError} when a tenant is at or above its cap.
 *
 * @param tenantId - Tenant the new job would belong to (`null` = global; not
 *   subject to the per-tenant cap).
 * @param current - Current count of non-terminal jobs for the tenant.
 * @param cap - Maximum allowed; `<= 0` disables the check.
 */
export function assertWithinTenantCreationCap(
  tenantId: string | null | undefined,
  current: number,
  cap: number,
): void {
  if (!tenantId || cap <= 0) return;
  if (current >= cap) {
    throw new TenantJobCapExceededError(tenantId, cap, current);
  }
}

/**
 * Class shape that opts into a background-method allowlist by declaring a
 * static set/array of method names.
 */
export interface BackgroundEligibleClass {
  /**
   * Method names that may be invoked by the job/agent runner. When present
   * (even if empty), it is treated as an exhaustive allowlist. When absent,
   * the runner falls back to its default behaviour (any existing method).
   */
  backgroundEligibleMethods?: ReadonlyArray<string> | ReadonlySet<string>;
}

/**
 * Add method names to a class's background-eligible allowlist.
 *
 * Installs/extends a static `backgroundEligibleMethods` set on the constructor.
 * Once any method is marked, the runner refuses to dispatch a job whose
 * `method` is not in the set — turning the dispatch surface from "any prototype
 * method" into an explicit contract. Use this when applying the
 * {@link backgroundEligible} decorator is inconvenient (or in non-decorator
 * code, including the agents package).
 *
 * @param ctor - The class constructor to annotate.
 * @param methods - Method names to allow.
 */
export function markBackgroundEligible(
  ctor: object,
  ...methods: string[]
): void {
  const target = ctor as { backgroundEligibleMethods?: ReadonlySet<string> };
  const existing = target.backgroundEligibleMethods;
  const set =
    existing instanceof Set
      ? new Set<string>(existing)
      : new Set<string>(existing ?? []);
  for (const method of methods) set.add(method);
  target.backgroundEligibleMethods = set;
}

/**
 * Decorator: mark a method as background-eligible.
 *
 * This is a legacy (`experimentalDecorators`) method decorator — the mode the
 * SMRT monorepo compiles with. Applying it (one or more times) builds up the
 * static `backgroundEligibleMethods` allowlist on the owning class. Once any
 * method is marked, the runner will refuse to dispatch a job whose `method` is
 * not in the set.
 *
 * @example
 * ```ts
 * class Report extends SmrtObject {
 *   \@backgroundEligible()
 *   async regenerate() {}   // reachable from a job
 *
 *   async deleteEverything() {} // NOT reachable from a job
 * }
 * ```
 */
export function backgroundEligible() {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor?: PropertyDescriptor,
  ): PropertyDescriptor | undefined => {
    // Legacy method decorators receive the prototype as `target`; the class
    // constructor (where we keep the static allowlist) is `target.constructor`.
    const ctor = (target as { constructor: object }).constructor;
    markBackgroundEligible(ctor, String(propertyKey));
    return descriptor;
  };
}

/**
 * Resolve the declared allowlist for a class, if any.
 *
 * @param ctor - The target object's constructor.
 * @returns A `Set` of allowed method names, or `null` when the class did not
 *   opt in (runner should fall back to default behaviour).
 */
export function getBackgroundEligibleMethods(
  ctor: unknown,
): ReadonlySet<string> | null {
  const declared = (ctor as BackgroundEligibleClass | undefined)
    ?.backgroundEligibleMethods;
  if (declared == null) return null;
  return declared instanceof Set ? declared : new Set(declared);
}

/**
 * Whether a method may be invoked by the runner for a given target class.
 *
 * @param ctor - Constructor of the resolved target class.
 * @param method - Method name from the persisted job row.
 * @returns `true` when the class declared no allowlist (default) or when the
 *   method is on the allowlist; `false` when an allowlist exists and excludes
 *   the method.
 */
export function isBackgroundEligibleMethod(
  ctor: unknown,
  method: string,
): boolean {
  const allow = getBackgroundEligibleMethods(ctor);
  if (allow == null) return true;
  return allow.has(method);
}

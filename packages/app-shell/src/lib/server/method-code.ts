// The method-code entitlement in the cloud profile (#5194, decision on #5597):
// a hosted app runs app-authored method code only for a tenant whose plan
// grants the standard `app.methods` feature. The engine asks this on its host,
// per call (`HostOptions.methodCode`, wired through `ShellContext.methodCode`),
// so a change of plan applies at once. The desktop (local profile) never
// reaches any of this: nothing is imported, built or read there.
//
// smrt-features and smrt-subscriptions are imported lazily, only on the cloud
// path (as in `hosted-inference.ts`), so a desktop process never registers
// their models.
import type { DatabaseInterface } from '@happyvertical/sql';
import { shellProfile } from './host.ts';
import { inTenant } from './hosted-inference.ts';

/** Whether the tenant's plan grants `app.methods` (and no override disables it). */
export type MethodCodeEntitlement = (tenantId: string) => Promise<boolean>;

let installed: MethodCodeEntitlement | undefined;

/** The real stores over one database: smrt-features' flag resolver and smrt-subscriptions' plan grants. */
export async function createMethodCodeEntitlement(
  db: DatabaseInterface,
): Promise<MethodCodeEntitlement> {
  const [features, subscriptions] = await Promise.all([
    import('@happyvertical/smrt-features'),
    import('@happyvertical/smrt-subscriptions'),
  ]);
  const resolver = new features.FeatureResolver({ db });
  const grantSource = await subscriptions.SubscriptionFeatureSource.create(
    { db },
    { memoize: false },
  );
  return (tenantId) =>
    inTenant(tenantId, () =>
      resolver.isEnabled(features.FEATURE_APP_METHODS, {
        tenantId,
        grantSource,
      }),
    );
}

/**
 * Cloud only: build the entitlement check once at startup. Throws (so the
 * server does not start) when the stores cannot be built. Local: does nothing.
 */
export async function installMethodCodeGate(options: {
  db: () => Promise<DatabaseInterface>;
  /** Tests: a fake in place of the real stores. */
  entitled?: MethodCodeEntitlement;
}): Promise<void> {
  if ((await shellProfile()) !== 'cloud') return;
  installed =
    options.entitled ?? (await createMethodCodeEntitlement(await options.db()));
}

/** Tests: forget the installed check. */
export function resetMethodCodeGate(): void {
  installed = undefined;
}

/**
 * The `ShellContext.methodCode` gate. With no check installed it throws, which
 * the engine reads as a failed lookup (a refusal), never as "yes".
 */
export async function isMethodCodeEntitled(tenantId: string): Promise<boolean> {
  if (!installed)
    throw new Error('the method code entitlement check is not installed');
  return installed(tenantId);
}

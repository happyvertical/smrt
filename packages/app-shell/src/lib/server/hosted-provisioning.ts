// Hosted key provisioning and the entitlement-change listener (#5194).
//
// When a tenant's plan gains, loses or changes `inference.hosted`, the billing
// writer (the host's webhook, wrapped in smrt-subscriptions'
// `trackEntitlementChange`) notifies the listeners registered in this process.
// The one registered here reconciles the tenant with smrt-inference's
// provisioner: entitled provisions a gateway key for each active member
// (budget from the grant's `metadata.budget`), not entitled revokes them.
//
// Cloud only, and only where the operator configured a gateway
// (`SMRT_INFERENCE_HOSTED_*`): with none there is nothing to provision, the
// listener is not registered, and the gate still refuses every hosted call.
// The desktop never reaches this: nothing is imported or registered there.
import {
  createHostedInferenceEntitlementListener,
  createHostedInferenceProvisioner,
  type HostedGatewayAdmin,
  HostedInferenceError,
  hostedGatewayConfigFromEnv,
} from '@happyvertical/smrt-inference/node';
import type { DatabaseInterface } from '@happyvertical/sql';
import { shellProfile } from './host.ts';
import { isHostedInferenceEntitled } from './hosted-inference.ts';

/** Who the provisioner records as acting in the audit log. */
export const HOSTED_PROVISIONING_ACTOR = 'smrt-app-shell';

let unregister: (() => void) | undefined;

/**
 * The users who should hold a hosted key while the tenant is entitled: its
 * active members.
 */
async function activeMembers(
  db: DatabaseInterface,
  tenantId: string,
): Promise<string[]> {
  const { MembershipCollection } = await import('@happyvertical/smrt-users');
  const memberships = await (
    await MembershipCollection.create({ db })
  ).findActiveByTenant(tenantId);
  return [...new Set(memberships.map((m) => String(m.userId)))].sort();
}

/**
 * Cloud only: register the entitlement-change listener for hosted inference.
 * Call after `installHostedInferenceGate` (the provisioner's entitlement
 * re-check uses its stores). Returns whether a listener was registered:
 * `false` locally, or when no hosted gateway is configured. A gateway that is
 * configured but incomplete throws, so the server does not start half set up.
 * The PostgreSQL pool needs at least three connections (the provisioner's
 * per-tenant advisory lock holds one while the operation uses others).
 */
export async function installHostedProvisioning(options: {
  db: () => Promise<DatabaseInterface>;
  /** Tests: a fake gateway admin client, in place of the real one. */
  admin?: HostedGatewayAdmin;
  /** Tests: the environment the gateway is read from (default `process.env`). */
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  if ((await shellProfile()) !== 'cloud') return false;
  const db = await options.db();
  const env = options.env ?? process.env;
  const gateway = hostedGatewayConfigFromEnv(env);
  if (!gateway) {
    // Gateway variables without a provider would be ignored silently: refuse.
    const stray = Object.keys(env).filter(
      (name) => name.startsWith('SMRT_INFERENCE_HOSTED_') && env[name]?.trim(),
    );
    if (stray.length > 0)
      throw new HostedInferenceError(
        `Hosted inference gateway variables are set (${stray.join(', ')}) but SMRT_INFERENCE_HOSTED_PROVIDER is not.`,
        'HOSTED_GATEWAY_NOT_CONFIGURED',
      );
    return false;
  }
  // The provisioned keys are stored as secrets: fail at start, not at the
  // first plan change.
  if (!process.env.SMRT_SECRET_MASTER_KEY?.trim())
    throw new HostedInferenceError(
      'Hosted inference provisioning needs SMRT_SECRET_MASTER_KEY.',
      'HOSTED_GATEWAY_NOT_CONFIGURED',
    );
  const provisioner = createHostedInferenceProvisioner({
    db,
    gateway,
    ...(options.admin ? { admin: options.admin } : {}),
    actor: HOSTED_PROVISIONING_ACTOR,
    entitled: isHostedInferenceEntitled,
  });
  const { registerEntitlementChangeListener } = await import(
    '@happyvertical/smrt-subscriptions'
  );
  unregister?.();
  unregister = registerEntitlementChangeListener(
    createHostedInferenceEntitlementListener({
      provisioner,
      users: (tenantId) => activeMembers(db, tenantId),
    }),
  );
  return true;
}

/** Tests: drop the registered listener. */
export function resetHostedProvisioning(): void {
  unregister?.();
  unregister = undefined;
}

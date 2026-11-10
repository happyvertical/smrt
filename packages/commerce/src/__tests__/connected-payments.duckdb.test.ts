/** Narrow DuckDB checkout evidence; full Payment's FK closure requires SQLite/Postgres. */
import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { expect, it } from 'vitest';
import { PaymentIntentCollection } from '../collections/PaymentIntentCollection.js';
import {
  createConnectedCheckout,
  linkTenantPaymentAccount,
  setTenantPaymentFeePolicy,
} from '../connected-payments.js';
import { withConnectedPaymentAuthority } from '../connected-payments-internal.js';
import { StripeConnectFixture } from './helpers/stripe-connect-fixture.js';

it('persists and freezes checkout policy provenance on DuckDB independently of account policy', async () => {
  const db = await getTestDatabase({
    type: 'duckdb',
    url: ':memory:',
    classes: ['PaymentIntent', 'TenantPaymentAccount'],
  });
  enableTenancy();
  try {
    const tenantId = randomUUID();
    const stripe = new StripeConnectFixture();
    const providerAccountId = stripe.accountId('bakeryduckdb');
    stripe.addAccount(providerAccountId, true, {
      smrt_tenant_id: tenantId,
      smrt_environment: 'test',
    });
    const gateway = stripe.adapter();
    await linkTenantPaymentAccount({
      db,
      tenantId,
      gateway,
      environment: 'test',
      providerAccountId,
    });
    const input = {
      db,
      tenantId,
      gateway,
      environment: 'test' as const,
      offeringRef: 'bakery-share',
      licenseeEmail: 'buyer@example.org',
      idempotencyKey: 'purchase',
      amount: 10000,
      currency: 'USD',
      applicationFeeAmount: 500,
      feePolicyRef: 'bakery:agreement:v1',
    };
    const first = await createConnectedCheckout(input);
    await setTenantPaymentFeePolicy({
      db,
      tenantId,
      environment: 'test',
      feePolicyRef: 'bakery:agreement:v2',
    });
    const retry = await createConnectedCheckout(input);
    expect(retry.intent.id).toBe(first.intent.id);
    expect(retry.intent.connectedFeePolicyRef).toBe(input.feePolicyRef);
    await expect(
      createConnectedCheckout({
        ...input,
        feePolicyRef: 'bakery:agreement:v2',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await withTenant({ tenantId }, async () => {
      const row = await (await PaymentIntentCollection.create({ db })).get({
        id: first.intent.id!,
      });
      expect(row!.connectedFeePolicyRef).toBe(input.feePolicyRef);
      row!.connectedFeePolicyRef = 'forged';
      await expect(
        withConnectedPaymentAuthority(tenantId, () => row!.save()),
      ).rejects.toThrow('cannot change');
    });
  } finally {
    disableTenancy();
    await db.close?.();
  }
});

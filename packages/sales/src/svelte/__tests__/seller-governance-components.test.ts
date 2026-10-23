import { flushSync, mount, unmount } from 'svelte';
import { afterEach, expect, it, vi } from 'vitest';
import SellerGovernancePanel from '../components/SellerGovernancePanel.svelte';
import type { SellerGovernanceView } from '../types.js';

let instance: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (instance) unmount(instance);
  instance = undefined;
  document.body.innerHTML = '';
});
const view = (): SellerGovernanceView => ({
  sellerLabel: 'Seller',
  authorized: true,
  advertiserLabel: 'Canonical advertiser',
  lease: null,
  canReview: true,
  quote: {
    tenantId: 'tenant',
    quoteId: 'quote',
    revision: 3,
    sellerId: 'seller',
    advertiserId: 'advertiser',
    makerProfileId: 'maker',
    rateCardVersion: 'rates-v2',
    inventoryVersion: 'inventory-v4',
    subtotalCents: 10000,
    totalCents: 8000,
    currency: 'CAD',
    policy: {
      version: 'v1',
      maxDiscountBps: 1000,
      leaseDurationMs: 10000,
      approvalDurationMs: 10000,
    },
    status: 'draft',
    approval: {
      requestId: 'request',
      status: 'pending',
      termsHash: 'hash',
      checkerProfileId: null,
      expiresAtMs: 999999,
      reason: '',
    },
  },
});
function render(value: SellerGovernanceView, busy = false) {
  const target = document.createElement('div');
  document.body.append(target);
  const onAction = vi.fn();
  instance = mount(SellerGovernancePanel, {
    target,
    props: { view: value, busy, onAction },
  });
  flushSync();
  return { target, onAction };
}
it('requires review reason and returns exact frozen quote/request tokens', () => {
  const { target, onAction } = render(view());
  const button = [...target.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === 'Approve',
  )!;
  expect(button.disabled).toBe(true);
  const reason = target.querySelector('textarea')!;
  reason.value = 'Reviewed exception';
  reason.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  button.click();
  expect(onAction).toHaveBeenCalledWith(
    expect.objectContaining({
      action: 'approve',
      quoteId: 'quote',
      revision: 3,
      requestId: 'request',
      reason: 'Reviewed exception',
    }),
  );
});
it('disables seller actions without authority and all actions while busy', () => {
  const unauthorized = view();
  unauthorized.authorized = false;
  unauthorized.canReview = false;
  const { target, onAction } = render(unauthorized);
  for (const button of target.querySelectorAll('button')) {
    expect(button.disabled).toBe(true);
    button.click();
  }
  expect(onAction).not.toHaveBeenCalled();
});
it('binds release/renew to the displayed lease token', () => {
  const value = view();
  value.quote = null;
  value.lease = {
    tenantId: 'tenant',
    sellerId: 'seller',
    advertiserId: 'advertiser',
    leaseId: 'lease-token',
    expiresAtMs: 100000,
    released: false,
  };
  const { target, onAction } = render(value);
  const release = [...target.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Release'),
  )!;
  release.click();
  expect(onAction).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'release', leaseId: 'lease-token' }),
  );
});

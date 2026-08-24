/** Fail-closed customer/tenant mismatch without revealing row existence. */
export class CampaignCustomerScopeError extends Error {
  readonly code = 'CAMPAIGN_CUSTOMER_SCOPE';

  constructor(label: string) {
    super(`${label}: customer scope validation failed.`);
    this.name = 'CampaignCustomerScopeError';
  }
}

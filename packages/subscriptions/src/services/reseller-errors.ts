export type ResellerBillingErrorCode =
  | 'INVALID_TENANT'
  | 'INVALID_CURRENCY'
  | 'INVALID_AMOUNT'
  | 'PRICE_BOOK_NOT_FOUND'
  | 'PRICE_BOOK_INACTIVE'
  | 'PRICE_BOOK_KIND_MISMATCH'
  | 'PRICE_BOOK_OWNER_MISMATCH'
  | 'PRICE_BOOK_NOT_ASSIGNED'
  | 'NO_EFFECTIVE_PRICE'
  | 'RELATIONSHIP_REQUIRED'
  | 'POLICY_NOT_FOUND'
  | 'POLICY_NOT_BALANCE'
  | 'POLICY_CONFLICT'
  | 'ASSIGNMENT_CONFLICT';

/** A reseller price book, rating, or delegated-spending rule was violated. */
export class ResellerBillingError extends Error {
  constructor(
    message: string,
    public readonly code: ResellerBillingErrorCode,
  ) {
    super(message);
    this.name = 'ResellerBillingError';
  }
}

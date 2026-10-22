/**
 * Errors thrown by {@link LotService} and by {@link StockService} when a
 * mutation names a lot. Kept in their own module so both services can
 * import them without a cycle.
 *
 * @packageDocumentation
 */

/** The lot id does not exist (or belongs to another tenant). */
export class LotNotFoundError extends Error {
  override name = 'LotNotFoundError';

  constructor(public readonly lotId: string) {
    super(`Lot not found: ${lotId}`);
  }
}

/** A stock mutation named a lot that belongs to a different SKU. */
export class LotMismatchError extends Error {
  override name = 'LotMismatchError';

  constructor(
    public readonly lotId: string,
    public readonly lotSkuId: string,
    public readonly skuId: string,
  ) {
    super(`Lot ${lotId} is of sku ${lotSkuId}, not ${skuId}`);
  }
}

/**
 * A unique lot or serial with this number already exists. Carries the
 * existing lot's id so the caller can link to it.
 */
export class DuplicateLotError extends Error {
  override name = 'DuplicateLotError';

  constructor(
    public readonly lotNumber: string,
    public readonly existingLotId: string | null,
  ) {
    super(`A lot with number "${lotNumber}" already exists`);
  }
}

/** An exclusive lot is already in use by a different consumer. */
export class LotInUseError extends Error {
  override name = 'LotInUseError';

  constructor(
    public readonly lotId: string,
    public readonly consumerType: string,
    public readonly consumerId: string,
  ) {
    super(`Lot ${lotId} is already in use by ${consumerType}:${consumerId}`);
  }
}

/** A correction was refused: missing or oversized reason, or nothing changes. */
export class LotCorrectionError extends Error {
  override name = 'LotCorrectionError';
}

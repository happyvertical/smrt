/**
 * #3106: a consumer package's own `LicenseSale` registered first, then
 * smrt-commerce loaded. Neither adopts the other's registration or table.
 */
import type { SmrtObject } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertLicenseSalesCoexist,
  defineConsumerLicenseSale,
} from './helpers/consumer-license-sale.js';

describe('consumer LicenseSale next to smrt-commerce (consumer first)', () => {
  let consumer: { ctor: typeof SmrtObject; dispose: () => void };
  beforeAll(async () => {
    consumer = await defineConsumerLicenseSale();
    await import('../index.js');
  });
  afterAll(() => consumer?.dispose());

  it('keeps each LicenseSale on its own identity and table', async () => {
    await assertLicenseSalesCoexist(consumer.ctor);
  });
});

/**
 * #3106: smrt-commerce loaded first, then a consumer package's own
 * `LicenseSale`. Neither adopts the other's registration or table.
 */
import '../index.js';

import type { SmrtObject } from '@happyvertical/smrt-core';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertLicenseSalesCoexist,
  defineConsumerLicenseSale,
} from './helpers/consumer-license-sale.js';

describe('consumer LicenseSale next to smrt-commerce (commerce first)', () => {
  let consumer: { ctor: typeof SmrtObject; dispose: () => void };
  beforeAll(async () => {
    consumer = await defineConsumerLicenseSale();
  });
  afterAll(() => consumer?.dispose());

  it('keeps each LicenseSale on its own identity and table', async () => {
    await assertLicenseSalesCoexist(consumer.ctor);
  });
});

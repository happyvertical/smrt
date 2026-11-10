/**
 * Consumer model for the #4176 server-path gate: a subclass of
 * smrt-commerce's `Agreement` in an app that also installs smrt-sales, whose
 * own `Agreement` shares the simple name. The spec scans this file with the
 * real OXC scanner to produce the app's `.smrt/manifest.json`.
 */
import { Agreement } from '@happyvertical/smrt-commerce';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';

@smrt()
export class AdvertisingProductContract extends Agreement {
  placement: string = '';
}

export class AdvertisingProductContractCollection extends SmrtCollection<AdvertisingProductContract> {
  static readonly _itemClass = AdvertisingProductContract;
}

/** Runtime app replacements, dynamically imported after their package models. */

import { Asset as SmrtAsset } from '@happyvertical/smrt-assets';
import { smrt } from '@happyvertical/smrt-core';

export const Asset: typeof SmrtAsset = class Asset extends SmrtAsset {};
smrt({ packageName: '@local/issue4931-ingestion' })(Asset);

/** Loaded after package models, with their existing physical tables. */
import { smrt } from '@happyvertical/smrt-core';
import { FieldUsageCounter as BaseFieldUsageCounter } from '../models/FieldUsageCounter.js';
@smrt({
  packageName: '@local/issue4931-fields',
  tableName: '_smrt_field_usage_counters',
})
export class FieldUsageCounter extends BaseFieldUsageCounter {}

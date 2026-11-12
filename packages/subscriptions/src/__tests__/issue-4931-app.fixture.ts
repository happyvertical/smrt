/** Loaded after package models, with their existing physical tables. */
import { smrt } from '@happyvertical/smrt-core';
import { SubscriptionPlanVersion as BaseSubscriptionPlanVersion } from '../models/SubscriptionPlanVersion.js';
@smrt({
  packageName: '@local/issue4931-subscriptions',
  tableName: '_smrt_subscription_plan_versions',
})
export class SubscriptionPlanVersion extends BaseSubscriptionPlanVersion {}

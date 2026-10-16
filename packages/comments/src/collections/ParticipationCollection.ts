import { SmrtCollection } from '@happyvertical/smrt-core';
import { ParticipationBan } from '../models/ParticipationBan.js';
import { ParticipationPolicy } from '../models/ParticipationPolicy.js';
import { ParticipationRateBucket } from '../models/ParticipationRateBucket.js';

export class ParticipationPolicyCollection extends SmrtCollection<ParticipationPolicy> {
  static readonly _itemClass = ParticipationPolicy;
}
export class ParticipationBanCollection extends SmrtCollection<ParticipationBan> {
  static readonly _itemClass = ParticipationBan;
}
export class ParticipationRateBucketCollection extends SmrtCollection<ParticipationRateBucket> {
  static readonly _itemClass = ParticipationRateBucket;
}

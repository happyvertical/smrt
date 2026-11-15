/** Loaded after package models, with their existing physical tables. */
import { smrt } from '@happyvertical/smrt-core';
import { SmrtJobEvent as BaseSmrtJobEvent } from '../smrt-job-event.js';
@smrt({ packageName: '@local/issue4931-jobs', tableName: '_smrt_job_events' })
export class SmrtJobEvent extends BaseSmrtJobEvent {}

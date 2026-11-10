import { SmrtCollection } from '@happyvertical/smrt-core';
import { CommentReport } from '../models/CommentReport.js';

export class CommentReportCollection extends SmrtCollection<CommentReport> {
  static readonly _itemClass = CommentReport;
}

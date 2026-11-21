/** Runtime app replacements, dynamically imported after their package models. */
import { smrt } from '@happyvertical/smrt-core';
import { AttendanceCorrection as SmrtAttendanceCorrection } from '../attendance/correction-models.js';
import {
  AttendanceBreak as SmrtAttendanceBreak,
  AttendanceSegment as SmrtAttendanceSegment,
} from '../attendance/models.js';
import {
  PeriodTimecard as SmrtPeriodTimecard,
  TimecardAdjustment as SmrtTimecardAdjustment,
  TimecardReopening as SmrtTimecardReopening,
} from '../rollup/models.js';

export const AttendanceBreak: typeof SmrtAttendanceBreak = class AttendanceBreak extends SmrtAttendanceBreak {};
smrt({ replaceParent: true, packageName: '@local/issue4931-timesheets' })(
  AttendanceBreak,
);

export const AttendanceSegment: typeof SmrtAttendanceSegment = class AttendanceSegment extends SmrtAttendanceSegment {};
smrt({ replaceParent: true, packageName: '@local/issue4931-timesheets' })(
  AttendanceSegment,
);

export const AttendanceCorrection: typeof SmrtAttendanceCorrection = class AttendanceCorrection extends SmrtAttendanceCorrection {};
smrt({ replaceParent: true, packageName: '@local/issue4931-timesheets' })(
  AttendanceCorrection,
);

export const PeriodTimecard: typeof SmrtPeriodTimecard = class PeriodTimecard extends SmrtPeriodTimecard {};
smrt({ replaceParent: true, packageName: '@local/issue4931-timesheets' })(
  PeriodTimecard,
);

export const TimecardAdjustment: typeof SmrtTimecardAdjustment = class TimecardAdjustment extends SmrtTimecardAdjustment {};
smrt({ replaceParent: true, packageName: '@local/issue4931-timesheets' })(
  TimecardAdjustment,
);

export const TimecardReopening: typeof SmrtTimecardReopening = class TimecardReopening extends SmrtTimecardReopening {};
smrt({ replaceParent: true, packageName: '@local/issue4931-timesheets' })(
  TimecardReopening,
);

---
type: "Component"
title: "@happyvertical/smrt-timesheets"
description: "Shared time entries for the SMRT framework: who worked how long on what, approval and correction, with immutable charge and compensation snapshots"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:33b3f89bd3d41c7ae0d84d09b08b8d3566ab274ea8138882f952ac2ae402ef8e"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/timesheets/package.json"
    title: "@happyvertical/smrt-timesheets package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/timesheets/AGENTS.md"
    title: "@happyvertical/smrt-timesheets packages/timesheets/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/timesheets/agents/period-rollup.md"
    title: "@happyvertical/smrt-timesheets packages/timesheets/agents/period-rollup.md"
---

# @happyvertical/smrt-timesheets

## Package

- Directory: `packages/timesheets`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/timesheets/AGENTS.md`
- `packages/timesheets/agents/period-rollup.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./attendance`
- `./manifest`
- `./manifest.json`
- `./rollup`
- `./svelte`
- `./ui`

## Models

- `AttendanceBreak` (collection `attendancebreaks`, extends `SmrtObject`)
- `AttendanceBreakCollection` (collection `attendancebreaks`, extends `SmrtCollection`)
- `AttendanceCorrection` (collection `attendancecorrections`, extends `SmrtObject`)
- `AttendanceCorrectionCollection` (collection `attendancecorrections`, extends `SmrtCollection`)
- `AttendancePunch` (collection `attendancepunches`, extends `SmrtObject`)
- `AttendancePunchCollection` (collection `attendancepunches`, extends `SmrtCollection`)
- `AttendanceReplay` (collection `attendancereplays`, extends `SmrtObject`)
- `AttendanceReplayCollection` (collection `attendancereplays`, extends `SmrtCollection`)
- `AttendanceSegment` (collection `attendancesegments`, extends `SmrtObject`)
- `AttendanceSegmentCollection` (collection `attendancesegments`, extends `SmrtCollection`)
- `PeriodTimecard` (collection `periodtimecards`, extends `SmrtObject`)
- `PeriodTimecardCollection` (collection `periodtimecards`, extends `SmrtCollection`)
- `ServiceChargeSnapshot` (collection `servicechargesnapshots`, extends `SmrtObject`)
- `ServiceChargeSnapshotCollection` (collection `servicechargesnapshots`, extends `SmrtCollection`)
- `ServiceCompensationSnapshot` (collection `servicecompensationsnapshots`, extends `SmrtObject`)
- `ServiceCompensationSnapshotCollection` (collection `servicecompensationsnapshots`, extends `SmrtCollection`)
- `ServiceTimeEntry` (collection `servicetimeentries`, extends `SmrtObject`)
- `ServiceTimeEntryCollection` (collection `servicetimeentries`, extends `SmrtCollection`)
- `TimecardAdjustment` (collection `timecardadjustments`, extends `SmrtObject`)
- `TimecardAdjustmentCollection` (collection `timecardadjustments`, extends `SmrtCollection`)
- `TimecardReopening` (collection `timecardreopenings`, extends `SmrtObject`)
- `TimecardReopeningCollection` (collection `timecardreopenings`, extends `SmrtCollection`)

## MCP tools

- `attendancebreak_get`: get on `@happyvertical/smrt-timesheets:AttendanceBreak`
- `attendancebreak_list`: list on `@happyvertical/smrt-timesheets:AttendanceBreak`
- `attendancepunch_get`: get on `@happyvertical/smrt-timesheets:AttendancePunch`
- `attendancepunch_list`: list on `@happyvertical/smrt-timesheets:AttendancePunch`
- `attendancesegment_get`: get on `@happyvertical/smrt-timesheets:AttendanceSegment`
- `attendancesegment_list`: list on `@happyvertical/smrt-timesheets:AttendanceSegment`
- `servicechargesnapshot_get`: get on `@happyvertical/smrt-timesheets:ServiceChargeSnapshot`
- `servicechargesnapshot_list`: list on `@happyvertical/smrt-timesheets:ServiceChargeSnapshot`
- `servicecompensationsnapshot_get`: get on `@happyvertical/smrt-timesheets:ServiceCompensationSnapshot`
- `servicecompensationsnapshot_list`: list on `@happyvertical/smrt-timesheets:ServiceCompensationSnapshot`
- `servicetimeentry_get`: get on `@happyvertical/smrt-timesheets:ServiceTimeEntry`
- `servicetimeentry_list`: list on `@happyvertical/smrt-timesheets:ServiceTimeEntry`
- `servicetimeentrycollection_forwork`: forWork on `@happyvertical/smrt-timesheets:ServiceTimeEntryCollection`
- `servicetimeentrycollection_pendingapproval`: pendingApproval on `@happyvertical/smrt-timesheets:ServiceTimeEntryCollection`

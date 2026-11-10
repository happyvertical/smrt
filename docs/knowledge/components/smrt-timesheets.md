---
type: "Component"
title: "@happyvertical/smrt-timesheets"
description: "Shared time entries for the SMRT framework: who worked how long on what, approval and correction, with immutable charge and compensation snapshots"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:cca831c121e9d971aca792f7ac52b9dbe8e648807e0d846c75ca2d16d61aba3c"
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
- Object source: `scanner`
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
- `AttendanceCorrection` (collection `attendancecorrections`, extends `SmrtObject`)
- `AttendancePunch` (collection `attendancepunches`, extends `SmrtObject`)
- `AttendanceReplay` (collection `attendancereplays`, extends `SmrtObject`)
- `AttendanceSegment` (collection `attendancesegments`, extends `SmrtObject`)
- `PeriodTimecard` (collection `periodtimecards`, extends `SmrtObject`)
- `ServiceChargeSnapshot` (collection `servicechargesnapshots`, extends `SmrtObject`)
- `ServiceChargeSnapshotCollection` (collection `servicechargesnapshotcollections`, extends `SmrtCollection`)
- `ServiceCompensationSnapshot` (collection `servicecompensationsnapshots`, extends `SmrtObject`)
- `ServiceCompensationSnapshotCollection` (collection `servicecompensationsnapshotcollections`, extends `SmrtCollection`)
- `ServiceTimeEntry` (collection `servicetimeentries`, extends `SmrtObject`)
- `ServiceTimeEntryCollection` (collection `servicetimeentrycollections`, extends `SmrtCollection`)
- `TimecardAdjustment` (collection `timecardadjustments`, extends `SmrtObject`)
- `TimecardReopening` (collection `timecardreopenings`, extends `SmrtObject`)

## MCP tools

- `forWork_servicetimeentrycollections`: forWork on `@happyvertical/smrt-timesheets:ServiceTimeEntryCollection`
- `get_attendancebreaks`: get on `@happyvertical/smrt-timesheets:AttendanceBreak`
- `get_attendancepunches`: get on `@happyvertical/smrt-timesheets:AttendancePunch`
- `get_attendancesegments`: get on `@happyvertical/smrt-timesheets:AttendanceSegment`
- `get_servicechargesnapshotcollections`: get on `@happyvertical/smrt-timesheets:ServiceChargeSnapshotCollection`
- `get_servicechargesnapshots`: get on `@happyvertical/smrt-timesheets:ServiceChargeSnapshot`
- `get_servicecompensationsnapshotcollections`: get on `@happyvertical/smrt-timesheets:ServiceCompensationSnapshotCollection`
- `get_servicecompensationsnapshots`: get on `@happyvertical/smrt-timesheets:ServiceCompensationSnapshot`
- `get_servicetimeentries`: get on `@happyvertical/smrt-timesheets:ServiceTimeEntry`
- `get_servicetimeentrycollections`: get on `@happyvertical/smrt-timesheets:ServiceTimeEntryCollection`
- `list_attendancebreaks`: list on `@happyvertical/smrt-timesheets:AttendanceBreak`
- `list_attendancepunches`: list on `@happyvertical/smrt-timesheets:AttendancePunch`
- `list_attendancesegments`: list on `@happyvertical/smrt-timesheets:AttendanceSegment`
- `list_servicechargesnapshotcollections`: list on `@happyvertical/smrt-timesheets:ServiceChargeSnapshotCollection`
- `list_servicechargesnapshots`: list on `@happyvertical/smrt-timesheets:ServiceChargeSnapshot`
- `list_servicecompensationsnapshotcollections`: list on `@happyvertical/smrt-timesheets:ServiceCompensationSnapshotCollection`
- `list_servicecompensationsnapshots`: list on `@happyvertical/smrt-timesheets:ServiceCompensationSnapshot`
- `list_servicetimeentries`: list on `@happyvertical/smrt-timesheets:ServiceTimeEntry`
- `list_servicetimeentrycollections`: list on `@happyvertical/smrt-timesheets:ServiceTimeEntryCollection`
- `pendingApproval_servicetimeentrycollections`: pendingApproval on `@happyvertical/smrt-timesheets:ServiceTimeEntryCollection`

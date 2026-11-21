---
type: "Component"
title: "@happyvertical/smrt-human-resources"
description: "HR records for the SMRT framework: who works for an organization, as what, and with what standing — employment with dated terms, and qualifications with expiry"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T22:32:40Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:85bd096515f1736c233230c768f27e2fbeeae17edb3c32b31c868f551719f9d2"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/human-resources/package.json"
    title: "@happyvertical/smrt-human-resources package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/human-resources/AGENTS.md"
    title: "@happyvertical/smrt-human-resources packages/human-resources/AGENTS.md"
---

# @happyvertical/smrt-human-resources

## Package

- Directory: `packages/human-resources`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/human-resources/AGENTS.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`
- `./ui`

## Models

- `Employment` (collection `employments`, extends `SmrtObject`)
- `EmploymentChange` (collection `employmentchanges`, extends `SmrtObject`)
- `EmploymentChangeCollection` (collection `employmentchangecollections`, extends `SmrtCollection`)
- `EmploymentCollection` (collection `employmentcollections`, extends `SmrtCollection`)
- `EmploymentTerm` (collection `employmentterms`, extends `SmrtObject`)
- `EmploymentTermCollection` (collection `employmenttermcollections`, extends `SmrtCollection`)
- `HeldQualification` (collection `heldqualifications`, extends `SmrtObject`)
- `HeldQualificationChange` (collection `heldqualificationchanges`, extends `SmrtObject`)
- `HeldQualificationChangeCollection` (collection `heldqualificationchangecollections`, extends `SmrtCollection`)
- `HeldQualificationCollection` (collection `heldqualificationcollections`, extends `SmrtCollection`)
- `Qualification` (collection `qualifications`, extends `SmrtObject`)
- `QualificationCollection` (collection `qualificationcollections`, extends `SmrtCollection`)

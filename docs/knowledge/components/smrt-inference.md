---
type: "Component"
title: "@happyvertical/smrt-inference"
description: "Inference alias chains with classified failures, recorded fallback and ladder degradation, plus the smrt doctor --ai binding check, for SMRT inference tiers"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T20:27:51Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:7979f9ff572b5dfe1a041ecdb86508c2a6a7eab7b79fb6041bb3dcd4c13d449e"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/package.json"
    title: "@happyvertical/smrt-inference package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/inference/AGENTS.md"
    title: "@happyvertical/smrt-inference packages/inference/AGENTS.md"
---

# @happyvertical/smrt-inference

## Package

- Directory: `packages/inference`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `manifest-described`

## Documentation

- `packages/inference/AGENTS.md`

## Framework dependencies

- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/sql`

## Exports

- `.`
- `./gate`
- `./node`
- `./resolver`

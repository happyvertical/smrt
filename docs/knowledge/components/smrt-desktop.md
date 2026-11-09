---
type: "Component"
title: "@happyvertical/smrt-desktop"
description: "Versioned sidecar manifest, installed-product contract and runtime bundler for SMRT desktop apps, plus the EXPERIMENTAL supervisor rendezvous (b) and native credential handoff (c) contracts, whose Rust shell half is not built"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-09T07:06:36Z"
audience: "internal"
evidence_level: "manifest-described"
source_revision: "sha256:fe84c4be8aad36f7d4a5332961c17d47ab3d80b21ab08a474803fb900875a903"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-desktop/package.json"
    title: "@happyvertical/smrt-desktop package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-desktop/AGENTS.md"
    title: "@happyvertical/smrt-desktop packages/smrt-desktop/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/smrt-desktop/README.md"
    title: "@happyvertical/smrt-desktop packages/smrt-desktop/README.md"
---

# @happyvertical/smrt-desktop

## Package

- Directory: `packages/smrt-desktop`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `manifest-described`

## Documentation

- `packages/smrt-desktop/AGENTS.md`
- `packages/smrt-desktop/README.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)

## Exports

- `.`
- `./bundler`
- `./package.json`
- `./testing`
- `./webview`

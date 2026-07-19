---
id: index
title: SMRT Framework
sidebar_label: Introduction
sidebar_position: 1
slug: /
---

# SMRT Framework

SMRT is a TypeScript framework for defining domain behavior once and using the resulting model graph for persistence, REST, CLI, MCP, AI operations, web clients, and mobile contracts.

## Requirements

- Node.js 24.18 or newer
- pnpm 11.13 or newer
- An explicitly prepared application schema

## Start here

Install the core package:

```bash
pnpm add @happyvertical/smrt-core
```

Then follow the repository's validated [quick start](https://github.com/happyvertical/smrt#quick-start). The root README is the canonical onboarding path; package pages in this site are copied from each package's README during `predev` and `prebuild`.

## Core principles

- Decorated domain classes are the source for generated interfaces.
- Runtime verifies application schema; migrations and tooling prepare it.
- Tenant isolation and package boundaries are explicit framework contracts.
- Package `AGENTS.md` files hold detailed architecture; READMEs are user-facing entry points.

## Next steps

- Browse **Packages** in the sidebar for install and API guidance.
- Read the [core architecture](./architecture/core-architecture.md).
- Read the [package standards](./standards.md) before contributing.

# @happyvertical/smrt-app-cli

Reusable, branded command-line and stdio MCP scaffolding for SMRT applications.

## Installation

```bash
pnpm add @happyvertical/smrt-app-cli
```

## What it provides

- App-facing resource commands discovered from SMRT metadata.
- Authenticated device-code login with bounded polling and clear failure states.
- Namespaced local configuration selected through `CliConfigContext`.
- Injectable output streams for deterministic tests and embedded runtimes.

## Usage

Create the CLI with the consuming application's identity and server settings, then register app-specific resources through the exported factory. Keep commands app-neutral: application models and policy stay in the host.

## Validation

```bash
pnpm --filter @happyvertical/smrt-app-cli test
pnpm --filter @happyvertical/smrt-app-cli typecheck
```

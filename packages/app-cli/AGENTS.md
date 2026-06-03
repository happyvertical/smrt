# @happyvertical/smrt-app-cli

Application CLI support for SMRT-based apps.

## Purpose

- Provides reusable app-facing CLI commands, currently centered on authenticated device-code login flows.
- Stores app CLI configuration in a namespaced local config file selected by the consuming app context.
- Intended for downstream apps that need a branded CLI without reimplementing auth polling, config persistence, and server URL handling.

## Patterns

- Keep commands app-agnostic; pass app identity through `CliConfigContext`.
- Treat transient auth polling failures as recoverable until the server-issued expiration window closes.
- Do not persist tokens, server URLs, or app slugs outside the configured local CLI config path.
- Keep command output stream-injectable so tests can assert behavior without writing to the real terminal.

## Gotchas

- This package depends on `@happyvertical/smrt-users` for the server-side auth contract but should not import app-specific user models.
- Device-code login polling should distinguish pending approval, transient server/network failures, expiry, and hard auth rejection.
- Tests should isolate config paths with package-specific environment prefixes.

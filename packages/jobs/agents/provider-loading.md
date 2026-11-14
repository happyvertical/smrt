# Retry SDK loading

`JobBuilder` does not import `@happyvertical/jobs` while a builder is created or
configured. `enqueue()` resolves the default exponential strategy on demand;
a supplied strategy keeps its original `toConfig()` behavior without loading
the SDK. The runner resolves `fromConfig` only while handling a retryable job
failure, after the existing MCP-suspension early return.

Keep the SDK's strategy implementation authoritative. Do not copy retry math
or load private hashed SDK chunks to avoid its provider barrel. The installed
SDK's root statically exports queue adapters; a public provider-neutral retry
entrypoint or lazy adapter factory is the upstream boundary needed to avoid
those modules on first default-strategy use. Dynamic import rejections propagate
unchanged; they are not converted into a fallback strategy.

`src/__tests__/job-builder.test.ts` guards zero SDK loads before enqueue and for
custom strategies, then checks the first default enqueue against the SDK's own
exponential configuration. Full runner tests cover persisted retry decisions,
hints, timeouts, ownership and terminal outcomes.

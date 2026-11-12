# Optional content capabilities

Ordinary content import/CRUD must not eagerly load document extraction,
filesystem provider SDKs or map-provider caches. Contents.mirror,
Contents.writeContentFile and map-thumbnail generation load their capability
through core's existing importOptionalDependency. Existing mirror URL validation,
SSRF checks, cache options, export formatting and thumbnail behavior stay at the
same boundary; only the load occurs at use. This also keeps these SDK graphs out
of downstream server output rather than merely delaying their execution.

The existing collection/thumbnail suites retain their behavior assertions. The
bundle-gate consumer-content fixture exercises the published dist surface with
SSR noExternal and rejects document/browser extraction and messaging-provider
SDK resolution. sharp/resvg are runtime-native externals, matching real apps.

Reuse: intent index, smrt-dev-mcp content review, rg by name and purpose in core,
content, images, chat and UI found importOptionalDependency and the existing
consumer-boundary gate; no new production helper or file is introduced.

Headline-card rendering also imports the image SDK inside the existing async
thumbnail operation. Importing content models or using other thumbnail strategies
must not initialize that SDK or Sharp. `thumbnail-generator.test.ts` adds a
fresh-Node published-root guard (fails on the original build) and retains the
headline-card input/output, persistence and other-strategy tests. The guard
refuses both image SDK and Sharp resolution; the existing rendering tests verify
that first use still dispatches to the SDK. No new public API, component, helper,
model or persistence path is introduced. All runtimes supported by this Node-only
server operation keep its async signature; SQL dialect behavior is unchanged.

Content editor chat resolves the AI SDK only when an actual send needs the default
client. Its existing injected `getAIClient` seam short-circuits that import; model
selection and missing-configuration errors still run first. The published-root
startup guard also refuses the AI SDK root. Existing chat and image-generation
operation tests prove the SDK is still reachable at first use. Reuse: MCP content
review and exact `getAI`/client-acquisition searches found this async send seam;
no second provider selector, wrapper, helper or public signature is introduced.

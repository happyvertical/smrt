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

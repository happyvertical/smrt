/**
 * Replaces `@mlc-ai/web-llm` in the MCP widget build (`scripts/build-mcp.ts`):
 * `@happyvertical/ai/local` imports it lazily, and the widget never reaches
 * that code because its engine host cannot load a model. A static named
 * import of the package would fail the build here, which is the intent.
 */
export {};

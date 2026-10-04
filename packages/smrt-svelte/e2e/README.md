Run `pnpm --filter @happyvertical/smrt-svelte test:e2e`; managed Chromium is the default.
Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium` to use installed Chromium.

Playwright first builds the fixtures with the installed Vite/Svelte toolchain,
then serves the compiled assets with Vite preview on `127.0.0.1:47851`. A failed
build or occupied port fails startup. The fixture build writes to ignored
`e2e/dist/`, separate from the package's published `dist/` output.

The build includes all five HTML entries: the shell (`index.html`), legacy dock
(`tools-dock.html`), MCP binding (`mcp-apps-binding.html`), its iframe child
(`mcp-apps-child.html`), and the native-form `FileUpload` page
(`file-upload.html`). A new fixture page must be added to the `input` list in
`e2e/vite.config.ts`, or preview serves nothing for it. Bundled assets avoid hundreds of development-module
requests during repeated browser navigations. All maintained browser assertions
run against these compiled fixtures without retries.

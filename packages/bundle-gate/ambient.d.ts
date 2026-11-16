// The Vite/Node fixture checks the emitted manifest. Static checking can run
// before the fields build, so represent that single JSON export as unknown.
declare module '@happyvertical/smrt-fields/manifest.json' {
  const manifest: unknown;
  export default manifest;
}

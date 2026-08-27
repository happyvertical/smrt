// `smrtPlugin` supplies the runtime virtual module during Vite builds. Keep
// source-first `svelte-check` useful before that build has emitted its ambient
// declaration, while preserving the generated shape when the plugin runs.
declare module '@happyvertical/smrt-virt-web' {
  export const webMcpToolDefinitions: readonly import('@happyvertical/smrt-web').WebMcpToolDefinition[];
}

/**
 * Ambient declarations for the SMRT Vite plugin's virtual modules.
 *
 * The plugin serves these under the `@happyvertical/smrt-virt-*` names at build
 * time, so plain `tsc` can't resolve them and the standalone/federation
 * entrypoints (`main.ts`, `client.ts`) fail to typecheck. Alias each to the
 * generated `@smrt/*` declarations (`src/lib/types/smrt-generated/`, produced by
 * `npm run generate`) so the demo entrypoints stay type-checked against the real
 * shapes.
 */
declare module '@happyvertical/smrt-virt-client' {
  export * from '@smrt/client';
  export { default } from '@smrt/client';
}

declare module '@happyvertical/smrt-virt-types' {
  export * from '@smrt/types';
}

declare module '@happyvertical/smrt-virt-manifest' {
  export * from '@smrt/manifest';
  export { default } from '@smrt/manifest';
}

declare module '@happyvertical/smrt-virt-mcp' {
  export * from '@smrt/mcp';
  export { default } from '@smrt/mcp';
}

declare module '@happyvertical/smrt-virt-routes' {
  export * from '@smrt/routes';
}

declare module '@happyvertical/smrt-virt-web' {
  export * from '@smrt/web';
  export { default } from '@smrt/web';
}

/**
 * Minimal `Bun` global for the standalone Bun demo server (`simple-server.ts`).
 * Declared narrowly here rather than via `@types/bun` so Bun's global overrides
 * (fetch/Response/etc.) don't pollute the browser/DOM (`main.ts`) and Node
 * (`simple-api-server.ts`) entrypoints that share this package's single tsconfig.
 */
declare const Bun: {
  serve(options: {
    port?: number;
    hostname?: string;
    fetch(request: Request): Response | Promise<Response>;
  }): { port: number };
};

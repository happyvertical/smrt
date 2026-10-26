/**
 * The Vite 5–8 capabilities SMRT actually consumes and implements.
 *
 * Keep this contract independent of Vite and its bundler types. A runtime
 * package must not acquire Vite peer contexts (and duplicate its registry),
 * and its published plugin declarations must not borrow a hoisted Vite.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type SmrtAwaitable<T> = T | Promise<T>;
export type SmrtHook<F> = F | { order?: 'pre' | 'post'; handler: F };

export interface SmrtConfigEnv {
  command: 'build' | 'serve';
  mode: string;
  isSsrBuild?: boolean;
  isPreview?: boolean;
}

export interface SmrtAlias {
  find: string | RegExp;
  replacement: string;
}

export interface SmrtDecoratorConfig {
  legacy?: boolean;
  emitDecoratorMetadata?: boolean;
}

/** Input capabilities, not a replacement for the application's full config. */
export interface SmrtUserConfig {
  root?: string;
  mode?: string;
  plugins?: readonly unknown[];
  oxc?: false | { decorator?: SmrtDecoratorConfig };
  worker?: { plugins?: () => SmrtInputPluginOption[] };
}

/** Config changes authored by SMRT's hooks. Every supported result is typed. */
export interface SmrtConfigResult {
  oxc?: { decorator: SmrtDecoratorConfig };
  resolve?: { dedupe: string[] };
  ssr?: { external?: string[]; noExternal?: string[] };
  build?: { rollupOptions?: { external?: RegExp[] } };
}

/** The opaque api/transform of another plugin is inspected before use. */
export interface SmrtConfiguredPlugin {
  name: string;
  api?: unknown;
  transform?: unknown;
}

/** Foreign plugins are passed through, never authored against SMRT's hooks. */
export type SmrtInputPluginOption =
  | SmrtConfiguredPlugin
  | false
  | null
  | undefined
  | SmrtInputPluginOption[]
  | Promise<
      SmrtConfiguredPlugin | false | null | undefined | SmrtInputPluginOption[]
    >;

export interface SmrtResolvedConfig {
  root: string;
  mode: string;
  command: 'build' | 'serve';
  plugins: readonly SmrtConfiguredPlugin[];
  oxc?: false | { decorator?: SmrtDecoratorConfig };
  resolve: { alias: readonly SmrtAlias[] };
  build: {
    ssr?: boolean | string;
    target?: string | string[] | false;
    lib?: false | { entry: string | string[] | Record<string, string> };
    minify?: boolean | string;
    outDir?: string;
    rollupOptions?: { output?: { dir?: string } | { dir?: string }[] };
  };
}

export interface SmrtResolveOptions {
  ssr?: boolean;
  skipSelf?: boolean;
}
export interface SmrtResolvedId {
  id: string;
  external?: boolean;
}
export interface SmrtHookContext {
  resolve(
    id: string,
    importer?: string,
    options?: SmrtResolveOptions,
  ): Promise<{ id: string } | null>;
  parse(code: string): { type: string };
  environment?: { config: { consumer?: string } };
}
export type SmrtTransformResult =
  | string
  | { code: string; map?: null }
  | null
  | void;
export type SmrtTransformHandler = (
  this: SmrtHookContext,
  code: string,
  id: string,
  options?: { ssr?: boolean },
) => SmrtAwaitable<SmrtTransformResult>;

export interface SmrtDevModule {
  id: string | null;
}
export interface SmrtDevServer {
  config: { root: string };
  middlewares: {
    use(
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
        next: () => void,
      ) => void,
    ): void;
  };
  transformIndexHtml(url: string, html: string): Promise<string>;
  watcher: {
    on(
      event: 'change' | 'add' | 'unlink',
      listener: (file: string) => void,
    ): void;
  };
  moduleGraph: { getModuleById(id: string): SmrtDevModule | undefined };
  reloadModule(module: SmrtDevModule): Promise<void>;
}

/** Accurate hook/result surface shared by the standalone plugins and preset. */
export interface SmrtVitePlugin<Api = undefined> {
  name: string;
  enforce?: 'pre' | 'post';
  apply?:
    | 'serve'
    | 'build'
    | ((config: SmrtUserConfig, env: SmrtConfigEnv) => boolean);
  api?: Api;
  config?: SmrtHook<
    (
      config: SmrtUserConfig,
      env: SmrtConfigEnv,
    ) => SmrtAwaitable<SmrtConfigResult | null | void>
  >;
  configResolved?: SmrtHook<
    (config: SmrtResolvedConfig) => SmrtAwaitable<void>
  >;
  buildStart?: SmrtHook<
    (this: SmrtHookContext, options: object) => SmrtAwaitable<void>
  >;
  transform?: SmrtHook<SmrtTransformHandler>;
  shouldTransformCachedModule?: SmrtHook<
    (this: SmrtHookContext, module: { id: string }) => boolean | null | void
  >;
  configureServer?: SmrtHook<(server: SmrtDevServer) => SmrtAwaitable<void>>;
  resolveId?: SmrtHook<
    (
      this: SmrtHookContext,
      id: string,
      importer: string | undefined,
      options: SmrtResolveOptions,
    ) => SmrtAwaitable<string | SmrtResolvedId | null | void>
  >;
  load?: SmrtHook<
    (this: SmrtHookContext, id: string) => SmrtAwaitable<string | null | void>
  >;
  transformIndexHtml?: SmrtHook<
    (
      html: string,
      context: { path: string; filename: string },
    ) => SmrtAwaitable<string>
  >;
  closeBundle?: SmrtHook<(this: SmrtHookContext) => SmrtAwaitable<void>>;
}

export type SmrtPluginOption =
  | SmrtVitePlugin<unknown>
  | false
  | null
  | undefined
  | SmrtPluginOption[]
  | Promise<
      SmrtVitePlugin<unknown> | false | null | undefined | SmrtPluginOption[]
    >;

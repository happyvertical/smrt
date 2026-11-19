/**
 * The app shell engine for tests, typed by the slice the tests use. Loaded by
 * path so the CLI's type checks never reach the shell's sources.
 */
import type {
  UserAppEngine,
  UserAppSection,
  UserAppVersionRecord,
} from '../user-app-portability.js';

export interface TestHost {
  execute(command: unknown, options: unknown): Promise<unknown>;
  create(model: string, data: Record<string, unknown>): Promise<unknown>;
  list(model: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

export interface TestStore {
  append(record: UserAppVersionRecord): Promise<void>;
  setCurrent(version: number): Promise<void>;
  current(): Promise<number | null>;
  list(): Promise<UserAppVersionRecord[]>;
}

export interface TestEngine extends UserAppEngine {
  AppHost: {
    open(dataDir: string, options: { store: TestStore }): Promise<TestHost>;
  };
  MemoryVersionStore: new () => TestStore;
  verifyUserApp(options: {
    dataDir: string;
    bundle: UserAppSection;
  }): Promise<{ ok: boolean }>;
}

// The CLI has no package edge to the shell; tests load its built engine by path.
const ENGINE_URL = new URL(
  '../../../../app-shell/dist/engine/index.js',
  import.meta.url,
).href;

export async function loadTestEngine(): Promise<TestEngine> {
  return (await import(ENGINE_URL)) as TestEngine;
}

/** Start a copy of a bundled user app on its own history. */
export async function openCopy(
  engine: TestEngine,
  dataDir: string,
  section: UserAppSection,
): Promise<TestHost> {
  const store = new engine.MemoryVersionStore();
  for (const v of section.versions) await store.append(v);
  await store.setCurrent(section.version);
  return engine.AppHost.open(dataDir, { store });
}

import type { BrowserAssistantTransport } from '../assistant/transport.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { setSamplePack } from '../data/packs.ts';
import { clearSampleContext } from '../data/sample-context.ts';
import type { DataSource } from '../data/source.ts';
import { libraryState } from '../library/state.svelte.ts';
import type { PlannerController } from './commands/index.ts';
import {
  rememberPlan,
  resetWorkspaceStorage,
  setRememberPlan,
  workspaceStorageManager,
} from './workspace-storage.ts';

export const PROJECT_PERSISTENCE_CONTEXT = Symbol(
  'planner-project-persistence-owner',
);

let revision = $state(0);
export const workspacePersistence = {
  get remembering() {
    void revision;
    return rememberPlan();
  },
  get recoveryAvailable() {
    void revision;
    return workspaceStorageManager().recoveryAvailable();
  },
  setRemember(value: boolean) {
    const ok = setRememberPlan(value);
    revision++;
    return ok;
  },
  recover() {
    const ok = workspaceStorageManager().recover();
    revision++;
    return ok;
  },
  discardRecovery() {
    const ok = workspaceStorageManager().discardRecovery();
    revision++;
    return ok;
  },
};

/** Called only after the visitor confirms; the host guards irreversible requests. */
export function resetWorkspace(options: {
  controller: PlannerController;
  dataSource: DataSource;
  nativeAssistant?: BrowserAssistantTransport;
  onreset?: () => void;
}): boolean {
  if (!resetWorkspaceStorage()) return false;
  try {
    options.nativeAssistant?.reset();
    cookbookStore.reset({ preserveTheme: true });
    libraryState.active = null;
    libraryState.appliedWork = null;
    clearSampleContext();
    setSamplePack(null);
    options.dataSource.reset?.();
    options.controller.resetWorkspace?.();
  } finally {
    revision++;
    options.onreset?.();
  }
  return true;
}

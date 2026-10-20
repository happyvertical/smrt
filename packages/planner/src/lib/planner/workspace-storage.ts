/** Project data is tab-scoped unless the visitor explicitly remembers it. */
export const REMEMBER_KEY = 'smrt-planner:remember:v1';
export const LEGACY_WORKSPACE_KEY = 'smrt-planner:legacy-workspace:v1';
export const EPHEMERAL_RECOVERY_KEY = 'smrt-planner:ephemeral-recovery:v1';
const EPHEMERAL_KEYS = new Set([
  'smrt-planner:conversation:v1',
  'smrt-planner:conversation-seed:v1',
  'smrt-planner:host-draft:v1',
  EPHEMERAL_RECOVERY_KEY,
]);
const isProjectKey = (key: string) =>
  ownsWorkspaceKey(key) && !EPHEMERAL_KEYS.has(key);
const MIGRATED_KEY = 'smrt-planner:workspace-migrated:v1';
const EXACT_KEYS = new Set([
  'smrt-planner:cookbook-doc:v1',
  'smrt-planner:blueprint:v1',
  'smrt-planner:cookbook-doc:unreadable',
  'smrt-planner:cookbook-doc:backup',
  'smrt-planner:cookbook',
  'smrt-planner:cookbook-applied',
  'smrt-planner:sample-context:v1',
  'smrt-planner:conversation:v1',
  'smrt-planner:conversation-seed:v1',
  'smrt-planner:host-draft:v1',
  EPHEMERAL_RECOVERY_KEY,
]);
export const ownsWorkspaceKey = (key: string): boolean =>
  EXACT_KEYS.has(key) || key.startsWith('smrt-planner:data:v6:');

function browser(kind: 'localStorage' | 'sessionStorage'): Storage | null {
  try {
    return globalThis[kind] ?? null;
  } catch {
    return null;
  }
}
function entries(storage: Storage | null): [string, string][] {
  if (!storage) return [];
  const result: [string, string][] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key && ownsWorkspaceKey(key)) {
      const value = storage.getItem(key);
      if (value !== null) result.push([key, value]);
    }
  }
  return result;
}
/** Storage is injected for deterministic tests and restricted browser contexts. */
export function createWorkspaceStorage(
  local: Storage | null,
  session: Storage | null,
) {
  let initialized = false;
  const remembering = () => local?.getItem(REMEMBER_KEY) === 'true';
  function initialize() {
    if (initialized) return;
    initialized = true;
    if (!local || !session) return;
    try {
      // Retire earlier durable chat/draft copies only after preserving exact
      // bytes in this tab. Conflicting old lead ids remain recoverable here.
      const ephemeral = entries(local).filter(([key]) =>
        EPHEMERAL_KEYS.has(key),
      );
      const archiveRaw = local.getItem(LEGACY_WORKSPACE_KEY);
      let archive: [string, string][] | undefined;
      if (archiveRaw) {
        const parsed: unknown = JSON.parse(archiveRaw);
        if (
          !Array.isArray(parsed) ||
          !parsed.every(
            (v) =>
              Array.isArray(v) &&
              v.length === 2 &&
              typeof v[0] === 'string' &&
              typeof v[1] === 'string',
          )
        )
          throw new Error('Unreadable legacy archive');
        archive = parsed;
        ephemeral.push(...archive.filter(([key]) => EPHEMERAL_KEYS.has(key)));
      }
      const conflicts: [string, string][] = [];
      for (const [key, value] of ephemeral) {
        const current = session.getItem(key);
        if (current === null) session.setItem(key, value);
        else if (current !== value) conflicts.push([key, value]);
      }
      if (conflicts.length) {
        const previous = session.getItem(EPHEMERAL_RECOVERY_KEY);
        session.setItem(
          EPHEMERAL_RECOVERY_KEY,
          JSON.stringify({ previous, values: conflicts }),
        );
      }
      if (archive?.some(([key]) => EPHEMERAL_KEYS.has(key))) {
        const project = archive.filter(([key]) => !EPHEMERAL_KEYS.has(key));
        if (project.length)
          local.setItem(LEGACY_WORKSPACE_KEY, JSON.stringify(project));
        else local.removeItem(LEGACY_WORKSPACE_KEY);
      }
      for (const [key] of ephemeral) local.removeItem(key);
    } catch (cause) {
      initialized = false;
      throw cause;
    }
    if (remembering() || local.getItem(MIGRATED_KEY)) return;
    const legacy = entries(local).filter(([key]) => isProjectKey(key));
    if (!legacy.length) return;
    // Preserve exact raw bytes before retiring old live keys. Never replace an archive.
    if (!local.getItem(LEGACY_WORKSPACE_KEY)) {
      try {
        local.setItem(LEGACY_WORKSPACE_KEY, JSON.stringify(legacy));
      } catch (cause) {
        initialized = false;
        throw cause;
      }
    }
    const before = entries(session);
    try {
      for (const [key, value] of legacy) {
        if (session.getItem(key) === null) session.setItem(key, value);
      }
      local.setItem(MIGRATED_KEY, 'true');
    } catch (cause) {
      for (const [key] of entries(session)) session.removeItem(key);
      for (const [key, value] of before) session.setItem(key, value);
      initialized = false;
      throw cause;
    }
    for (const [key] of legacy) local.removeItem(key);
  }
  const target = (key?: string) => {
    initialize();
    return key && EPHEMERAL_KEYS.has(key)
      ? session
      : remembering()
        ? local
        : session;
  };
  const storage: Storage = {
    get length() {
      initialize();
      return [
        ...entries(target()).filter(([key]) => isProjectKey(key)),
        ...entries(session).filter(([key]) => EPHEMERAL_KEYS.has(key)),
      ].length;
    },
    key(index) {
      initialize();
      return (
        [
          ...entries(target()).filter(([key]) => isProjectKey(key)),
          ...entries(session).filter(([key]) => EPHEMERAL_KEYS.has(key)),
        ][index]?.[0] ?? null
      );
    },
    getItem(key) {
      return ownsWorkspaceKey(key) ? (target(key)?.getItem(key) ?? null) : null;
    },
    setItem(key, value) {
      if (!ownsWorkspaceKey(key))
        throw new Error('Not a planner workspace key');
      const destination = target(key);
      if (!destination) throw new Error('Workspace storage unavailable');
      destination.setItem(key, value);
    },
    removeItem(key) {
      if (ownsWorkspaceKey(key)) target(key)?.removeItem(key);
    },
    clear() {
      initialize();
      for (const store of [local, session])
        for (const [key] of entries(store)) store?.removeItem(key);
    },
  };
  return {
    storage,
    remembering() {
      try {
        initialize();
        return remembering();
      } catch {
        return false;
      }
    },
    recoveryAvailable() {
      try {
        initialize();
        return !!local?.getItem(LEGACY_WORKSPACE_KEY);
      } catch {
        return false;
      }
    },
    setRemember(value: boolean): boolean {
      try {
        initialize();
        if (!local || !session) return false;
        if (remembering() === value) {
          if (!value) local.removeItem(LEGACY_WORKSPACE_KEY);
          return true;
        }
        const source = remembering() ? local : session;
        const destination = value ? local : session;
        const data = entries(source).filter(([key]) => isProjectKey(key));
        const before = entries(destination).filter(([key]) =>
          isProjectKey(key),
        );
        try {
          for (const [key] of before) destination.removeItem(key);
          for (const [key, raw] of data) destination.setItem(key, raw);
          local.setItem(REMEMBER_KEY, String(value));
        } catch {
          for (const [key] of entries(destination).filter(([key]) =>
            isProjectKey(key),
          ))
            destination.removeItem(key);
          for (const [key, raw] of before) destination.setItem(key, raw);
          return false;
        }
        if (source !== destination)
          for (const [key] of data) source.removeItem(key);
        if (!value) local.removeItem(LEGACY_WORKSPACE_KEY);
        return true;
      } catch {
        return false;
      }
    },
    discardRecovery(): boolean {
      try {
        local?.removeItem(LEGACY_WORKSPACE_KEY);
        return true;
      } catch {
        return false;
      }
    },
    recover(): boolean {
      try {
        initialize();
        const raw = local?.getItem(LEGACY_WORKSPACE_KEY);
        if (!raw) return false;
        const data: unknown = JSON.parse(raw);
        if (
          !Array.isArray(data) ||
          !data.every(
            (item) =>
              Array.isArray(item) &&
              item.length === 2 &&
              typeof item[0] === 'string' &&
              isProjectKey(item[0]) &&
              typeof item[1] === 'string',
          )
        )
          return false;
        const destination = target();
        if (!destination) return false;
        const before = entries(destination).filter(([key]) =>
          isProjectKey(key),
        );
        try {
          for (const [key] of before) destination.removeItem(key);
          for (const [key, value] of data) destination.setItem(key, value);
        } catch {
          for (const [key] of entries(destination).filter(([key]) =>
            isProjectKey(key),
          ))
            destination.removeItem(key);
          for (const [key, value] of before) destination.setItem(key, value);
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    reset(): boolean {
      // Snapshot before any mutation, including metadata; failed clears restore
      // exact raw project state and never reach the in-memory reset coordinator.
      const snapshots: { store: Storage; values: [string, string][] }[] = [];
      const wasInitialized = initialized;
      try {
        for (const store of [local, session]) {
          if (!store) continue;
          const values = entries(store);
          if (store === local) {
            for (const key of [
              LEGACY_WORKSPACE_KEY,
              REMEMBER_KEY,
              MIGRATED_KEY,
            ]) {
              const value = store.getItem(key);
              if (value !== null) values.push([key, value]);
            }
          }
          snapshots.push({ store, values });
        }
        // Write fallible metadata first; reset must not resurrect legacy work.
        local?.setItem(MIGRATED_KEY, 'true');
        for (const { store, values } of snapshots) {
          for (const [key] of values)
            if (key !== MIGRATED_KEY) store.removeItem(key);
        }
        initialized = true;
        return true;
      } catch {
        for (const { store, values } of snapshots) {
          try {
            for (const [key, value] of values) store.setItem(key, value);
            if (
              store === local &&
              !values.some(([key]) => key === MIGRATED_KEY)
            )
              store.removeItem(MIGRATED_KEY);
          } catch {
            /* Storage may have become entirely unavailable. */
          }
        }
        initialized = wasInitialized;
        return false;
      }
    },
  };
}
let active: ReturnType<typeof createWorkspaceStorage> | undefined;
export function workspaceStorageManager() {
  if (!active)
    active = createWorkspaceStorage(
      browser('localStorage'),
      browser('sessionStorage'),
    );
  return active;
}
export function workspaceStorage(): Storage {
  return workspaceStorageManager().storage;
}
export function rememberPlan(): boolean {
  return workspaceStorageManager().remembering();
}
export function setRememberPlan(value: boolean): boolean {
  return workspaceStorageManager().setRemember(value);
}
export function resetWorkspaceStorage(): boolean {
  return workspaceStorageManager().reset();
}

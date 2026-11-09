/**
 * #4735: smrt-ledgers and smrt-messages both declare `Account`, and both
 * manifests give it the collection `accounts` (ledgers' table is
 * `ledger_accounts`). Registering ledgers' `Account` auto-loads the classes on
 * that collection as STI siblings. Core took the already registered ledgers
 * `Account` for the messages one, so `EmailAccount`, `SlackAccount`, ... were
 * registered WITHOUT their base `@happyvertical/smrt-messages:Account`, and
 * `getAllSchemasAsDefinitions()` threw "Table 'accounts' is claimed by
 * unrelated classes".
 *
 * The registry starts empty in each test, and the messages family only ever
 * arrives from its manifest, never through the package root: the load order
 * the coexistence tests beside this one do not cover.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import ledgerManifest from '@happyvertical/smrt-ledgers/manifest.json';
import { beforeEach, describe, expect, it } from 'vitest';

const LEDGER_ACCOUNT = '@happyvertical/smrt-ledgers:Account';
const MESSAGES_ACCOUNT = '@happyvertical/smrt-messages:Account';
const SUBCLASSES = [
  'EmailAccount',
  'SlackAccount',
  'TelegramAccount',
  'TwitterAccount',
  'ZulipAccount',
].map((name) => `@happyvertical/smrt-messages:${name}`);

const ledgerManifestPath = createRequire(import.meta.url).resolve(
  '@happyvertical/smrt-ledgers/manifest.json',
);
const messagesManifestPath = fileURLToPath(
  new URL('../../dist/manifest.json', import.meta.url),
);

function registerLedgerAccountOnly(): void {
  const objects = (
    ledgerManifest as unknown as {
      objects: Record<
        string,
        Parameters<typeof ObjectRegistry.registerFromManifest>[1]
      >;
    }
  ).objects;
  ObjectRegistry.registerFromManifest(
    'Account',
    objects[LEDGER_ACCOUNT],
    '@happyvertical/smrt-ledgers',
  );
}

/** Leave only the path under test: sibling auto-loading has already run for `accounts`. */
function withoutSiblingAutoLoading(): void {
  (
    ObjectRegistry as unknown as { stiSiblingsLoaded: Set<string> }
  ).stiSiblingsLoaded.add('accounts');
}

describe('messages Account family beside the ledgers Account (#4735)', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  it('loads the base with its subclasses as siblings of the ledgers Account', () => {
    registerLedgerAccountOnly();

    expect(ObjectRegistry.getClass(LEDGER_ACCOUNT)).toBeDefined();
    expect(ObjectRegistry.getClass(MESSAGES_ACCOUNT)).toBeDefined();
    for (const name of SUBCLASSES) {
      expect(ObjectRegistry.getClass(name), name).toBeDefined();
      expect(ObjectRegistry.getSTIBase(name), name).toBe(MESSAGES_ACCOUNT);
    }
  });

  it('builds merged schemas without an unrelated-classes table claim', () => {
    registerLedgerAccountOnly();

    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(schemas.accounts).toBeDefined();
    expect(schemas.ledger_accounts).toBeDefined();
    // The ledger `number` column stays off the messaging table.
    expect(Object.keys(schemas.accounts.columns)).not.toContain('number');
  });

  it('registers the messages base when a subclass loads lazily by name', async () => {
    withoutSiblingAutoLoading();
    registerLedgerAccountOnly();
    const registered = () => ObjectRegistry.getAllClasses();
    expect(registered().has(MESSAGES_ACCOUNT)).toBe(false);
    expect(registered().has(SUBCLASSES[0])).toBe(false);

    expect(await ObjectRegistry.tryLoadFromExternalPackage(SUBCLASSES[0])).toBe(
      true,
    );

    // The ledgers `Account` is not this subclass's parent.
    expect(registered().has(MESSAGES_ACCOUNT)).toBe(true);
    expect(ObjectRegistry.getSTIBase(SUBCLASSES[0])).toBe(MESSAGES_ACCOUNT);
  });

  it.each([
    ['ledgers first', [ledgerManifestPath, messagesManifestPath]],
    ['messages first', [messagesManifestPath, ledgerManifestPath]],
  ])('registers both Accounts when every manifest is loaded upfront (%s)', (_order, manifestPaths) => {
    ObjectRegistry.loadAllManifests({ manifestPaths });

    expect(ObjectRegistry.getClass(MESSAGES_ACCOUNT)).toBeDefined();
    expect(ObjectRegistry.getClass(LEDGER_ACCOUNT)).toBeDefined();
    for (const name of SUBCLASSES) {
      expect(ObjectRegistry.getSTIBase(name), name).toBe(MESSAGES_ACCOUNT);
    }
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(schemas.accounts).toBeDefined();
    expect(schemas.ledger_accounts).toBeDefined();
  });
});

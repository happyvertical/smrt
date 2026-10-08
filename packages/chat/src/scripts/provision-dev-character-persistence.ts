/**
 * Provision the one fixed profile consumed by the opt-in local character
 * persistence route. Schema migration is intentionally external:
 * `DATABASE_URL=<same temporary sqlite path> pnpm smrt db:migrate` must have
 * completed before this script runs.
 */
import {
  ProfileCollection,
  ProfileMetafieldCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { getDatabase } from '@happyvertical/sql';
import { resolveDevCharacterPersistenceConfig } from '../routes/api/dev-character-persistence/config.js';

/** Pre-provisioned application-scoped key consumed by the dev helper route. */
export const DEV_HELPER_PREFERENCES_METAFIELD =
  'smrt-chat-dev-helper-preferences';

const config = resolveDevCharacterPersistenceConfig();
if (!config) {
  throw new Error(
    'Set SMRT_CHAT_DEV_CHARACTER_PERSISTENCE=true before provisioning.',
  );
}

const db = await getDatabase({ type: 'sqlite', url: config.databaseUrl });
try {
  const profiles = await ProfileCollection.create({ db });
  const existing = await profiles.get({ id: config.profileId });
  if (existing) {
    if (existing.tenantId !== config.tenantId) {
      throw new Error(
        'Configured dev character profile belongs to a different tenant.',
      );
    }
    process.stdout.write(`Dev character profile ready: ${config.profileId}\n`);
  } else {
    const types = await ProfileTypeCollection.create({ db });
    const type = await types.getOrCreateBySlug('person', { name: 'Person' });
    if (!type.id) {
      throw new Error('Dev character profile type was not persisted.');
    }
    const profile = await profiles.create({
      id: config.profileId,
      typeId: type.id,
      tenantId: config.tenantId,
      name: 'Local character workbench',
    });
    await profile.save();
    process.stdout.write(
      `Dev character profile provisioned: ${config.profileId}\n`,
    );
  }
  const metafields = await ProfileMetafieldCollection.create({ db });
  const candidates = await metafields.list({
    where: { slug: DEV_HELPER_PREFERENCES_METAFIELD },
  });
  const own = candidates.filter(
    (field) => (field.tenantId ?? null) === config.tenantId,
  );
  if (own.length > 1) {
    throw new Error('Dev helper preference metafield is ambiguous.');
  }
  if (!own[0]) {
    const metafield = await metafields.create({
      slug: DEV_HELPER_PREFERENCES_METAFIELD,
      name: 'SMRT chat dev helper preferences',
      tenantId: config.tenantId,
      description: 'Opt-in local helper presentation preferences.',
    });
    await metafield.save();
  }
} finally {
  await db.close?.();
}

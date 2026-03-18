import './src/lib/server/smrt-register.ts';
import '@happyvertical/smrt-chat';
import { resolveDatabase, ObjectRegistry } from '@happyvertical/smrt-core';

async function migrate() {
  const { ensureSchema } = await import('@happyvertical/smrt-core/schema/utils');
  
  const db = await resolveDatabase({
    type: 'sqlite',
    url: '.smrt/local.db'
  });

  ObjectRegistry.loadAllManifests();

  const classNames = ObjectRegistry.getClassNames();
  let created = 0;
  
  for (const className of classNames) {
    try {
      await ensureSchema(db, className);
      created++;
      console.log(`Created schema for ${className}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes('No table mapping')) {
        console.error(`Error for ${className}: ${message}`);
      }
    }
  }

  console.log(`Successfully ensured schemas for ${created} classes.`);
  process.exit(0);
}

migrate().catch(console.error);

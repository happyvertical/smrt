import { ObjectRegistry } from '@happyvertical/smrt-core';

async function main() {
  const { initSmrtRegistry } = await import('./src/lib/server/smrt-register.js');
  initSmrtRegistry();
  
  const registered = ObjectRegistry.getClasses().get('@happyvertical/smrt-content:Content');
  if (!registered) {
    console.log('Class @happyvertical/smrt-content:Content not found in ObjectRegistry!');
    return;
  }
  
  console.log('Fields in registry:');
  console.log(Array.from(registered.fields.keys()));
  
  const ddl = ObjectRegistry.getSchemaDDL('@happyvertical/smrt-content:Content');
  console.log('\nSchema DDL:');
  console.log(ddl);
}

main().catch(console.error);

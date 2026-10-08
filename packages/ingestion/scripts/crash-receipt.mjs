// Real process-death fixture. The parent provisions schema and owns cleanup.
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getDatabase } from '@happyvertical/sql';
import { IngestionService } from '../dist/server.js';
const config=JSON.parse(process.env.INGESTION_CRASH_CONFIG);
const db=await getDatabase({type:config.dialect,url:process.env.INGESTION_CRASH_DB});
const input=config.input;
input.parts=input.parts.map(p=>({...p,bytes:Buffer.from(p.bytes)}));
input.deliveredAt=new Date(input.deliveredAt);
for(const key of ['expiresAt','replayUntil','acceptAfter'])input.retention[key]=new Date(input.retention[key]);
const service=new IngestionService({db,assets:await createAssetRuntime({db,storage:config.storage}),scope:config.scope,authorize:async()=>true,jobTarget:config.jobTarget,purgeDerived:async()=>{},now:()=>new Date(config.now),checkpoint:async point=>{if(point===config.boundary)process.exit(73);}});
await service.receive(input);
await db.close?.();
process.exit(74);

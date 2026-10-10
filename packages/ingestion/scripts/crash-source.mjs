// Parent provisions real schema; this process exits between ready receipt and filesystem ack.
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getDatabase } from '@happyvertical/sql';
import { IngestionService, WatchFolderSourceAdapter } from '../dist/server.js';
const config = JSON.parse(process.env.INGESTION_SOURCE_CONFIG);
const db = await getDatabase({type:config.dialect,url:process.env.INGESTION_CRASH_DB});
let now = config.now;
const service = new IngestionService({db,assets:await createAssetRuntime({db,storage:`${config.root}/assets`}),scope:config.scope,authorize:async()=>true,jobTarget:config.jobTarget,purgeDerived:async()=>{},now:()=>new Date(now)});
for (const key of ['expiresAt','replayUntil','acceptAfter']) config.binding.retention[key] = new Date(config.binding.retention[key]);
const adapter = new WatchFolderSourceAdapter({binding:{...config.binding,service},directory:config.root,stabilityMs:1,now:()=>now,checkpoint:async(point)=>{if(point==='received')process.exit(73);}});
await adapter.poll(); now+=2; await adapter.poll(); now+=2; await adapter.poll();
await db.close?.(); process.exit(74);

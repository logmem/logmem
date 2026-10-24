// Metadata-only migration. Dry-run is the default. Never moves customer data.
import {pathToFileURL} from 'node:url';
import {customerRedis} from '../src/http/jail.mjs';
import {validTenantId,getTenant} from '../cloud/tenants/index.mjs';
import {validUser,ensureLegacyWorkspace,workspaceKey} from '../src/http/workspaces.mjs';
export async function migrateWorkspaces({redis,apply=false,tenantIds}={}) {
 const results=[];
 for(const tenantId of tenantIds||await redis('SMEMBERS','acmi:cloud:tenants')||[]) {
  if(!validTenantId(tenantId)){results.push({tenantId,status:'skipped'});continue;}
  const t=await getTenant(redis,tenantId),userId=await redis('GET',`lm:account:tenant:${tenantId}`);
  if(t?.status!=='active'||!validUser(userId)||await redis('GET',`lm:account:clerk:${userId}`)!==tenantId){results.push({tenantId,status:'skipped'});continue;}
  if(await redis('GET',workspaceKey(tenantId))){results.push({tenantId,status:'already-mapped'});continue;}
  if(apply)await ensureLegacyWorkspace({userId,tenantId},{redis});
  results.push({tenantId,status:apply?'mapped':'would-map'});
 }
 return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const args=process.argv.slice(2);if(args.some(a=>!['--apply','--dry-run'].includes(a)))throw new Error('Use --dry-run or --apply.');
 const result=await migrateWorkspaces({redis:customerRedis(),apply:args.includes('--apply')&&!args.includes('--dry-run')});
 process.stdout.write(JSON.stringify({applied:args.includes('--apply')&&!args.includes('--dry-run'),results:result},null,2)+'\n');
}

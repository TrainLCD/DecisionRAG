import worker from '../src/index.js';
import type {Env,SyncJob} from './reference/types.js';
export async function sync(env:Env,body:SyncJob){
  const id='test-job-'+crypto.randomUUID();let failed=false;
  await worker.queue!({messages:[{id,body,attempts:1,ack(){},retry(){failed=true;}}]} as unknown as MessageBatch<SyncJob>,env,{} as ExecutionContext);
  if(failed){const row=await env.DB.prepare('SELECT error FROM sync_jobs WHERE id=?').bind(id).first<{error:string}>();throw new Error(row?.error??'sync_failed');}
}
export async function webhook(request:Request,env:Env){
  const response=await worker.fetch!(request as Parameters<NonNullable<typeof worker.fetch>>[0],env,{} as ExecutionContext);
  if(!response.ok){const result=await response.json() as {error:string};throw new Error(result.error);}return response;
}

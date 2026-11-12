import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {fixture,mockFetch} from './helpers.js';
import {saveSource} from './reference/store.js';
import {encodeCursor} from './reference/search-cursor.js';
async function setup(n=41){const f=fixture();f.env.AI=undefined;
 f.sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','App','main')");
 for(let i=0;i<n;i++)await saveSource(f.env,{id:`doc${i}`,repo:'TrainLCD/App',kind:'issue',title:'GPS位置情報',body:`GPS位置情報を更新する。番号${i}。`,url:'https://example.test',metadata:{},updated_at:'2026-11-12'});
 const request=(body:any,path='search')=>worker.fetch!(new Request('https://example.test/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+f.env.API_TOKEN},body:JSON.stringify(body)}),f.env,{} as ExecutionContext);
 return {...f,request};}
test('Rust continuation visits every passage once and rejects tampering/query/revision changes',async()=>{
 const f=await setup();try{let cursor:any;const ids=new Set();let first:any;
 for(let i=1;i<=3;i++){const r=await f.request({query:'GPS',paginated:true,...(cursor?{cursor}:{})});assert.equal(r.status,200);const d:any=await r.json();assert.equal(d.pagination.page,i);assert.equal(d.pagination.total_pages,3);for(const p of d.evidence){assert.ok(!ids.has(p.id));ids.add(p.id);}cursor=d.pagination.next_cursor;if(i===1)first=cursor;}
 assert.equal(cursor,null);assert.equal(ids.size,41);
 for(const body of [{query:'GPS',paginated:true,cursor:first.slice(0,-2)+'aa'},{query:'widget',paginated:true,cursor:first},{query:'GPS',cursor:first}])assert.equal((await f.request(body)).status,400);
 f.sqlite.exec("UPDATE passages SET text=text||'変更' WHERE source_id='doc0'");assert.equal((await f.request({query:'GPS',paginated:true,cursor:first})).status,409);
 }finally{f.sqlite.close();}});
test('Rust authenticates legacy AES-GCM cursors and rejects expired plans',async()=>{const f=await setup(1);try{
 const value={query:'GPS',scope:'[true,null]',ids:['doc0'],offset:20,revision:'old',expires:Date.now()+60000};
 const token=await encodeCursor(value,f.env.API_TOKEN);assert.equal((await f.request({query:'GPS',paginated:true,cursor:token})).status,409);
 const expired=await encodeCursor({...value,expires:1},f.env.API_TOKEN);assert.equal((await f.request({query:'GPS',paginated:true,cursor:expired})).status,400);
 }finally{f.sqlite.close();}});
test('Rust enforces document budget and input types without truncating totals',async()=>{const f=await setup(3);try{
 f.env.MAX_SCREENED_DOCUMENTS='2';assert.equal((await f.request({query:'GPS'})).status,422);
 for(const body of [{query:''},{query:'x'.repeat(1501)},{query:3},{query:'GPS',include_feedback:'yes'},{query:'GPS',paginated:1}])assert.equal((await f.request(body)).status,400);
 }finally{f.sqlite.close();}});
test('Rust public search fails closed on rate limits and visibility errors',async()=>{const f=await setup(1);const call=()=>worker.fetch!(new Request('https://example.test/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'GPS'})}),f.env,{} as ExecutionContext);try{
 f.env.PUBLIC_SEARCH_RATE_LIMIT={limit:async()=>({success:false})} as RateLimit;const limited=await call();assert.equal(limited.status,429);assert.equal(limited.headers.get('retry-after'),'60');
 f.env.PUBLIC_SEARCH_RATE_LIMIT={limit:async()=>({success:true})} as RateLimit;const restore=mockFetch(()=>new Response('secret',{status:503}));try{const r=await call();assert.equal(r.status,502);assert.ok(!(await r.text()).includes('secret'));}finally{restore();}
 }finally{f.sqlite.close();}});
test('Rust scheduled and failed queue work preserve dispatch and retry semantics',async()=>{const f=await setup(0);try{
 await worker.scheduled!({} as ScheduledController,f.env,{} as ExecutionContext);assert.deepEqual(f.jobs,[{type:'org',page:1}]);
 let retry:any,acked=false;const restore=mockFetch(()=>new Response('denied',{status:503}));try{
 await worker.queue!({messages:[{id:'failed',body:{type:'org',page:1},attempts:2,ack(){acked=true},retry(v:any){retry=v}}]} as unknown as MessageBatch<any>,f.env,{} as ExecutionContext);
 assert.equal(acked,false);assert.ok(retry.delaySeconds>0);assert.equal((f.sqlite.prepare("SELECT status FROM sync_jobs WHERE id='failed'").get() as any).status,'retrying');
 }finally{restore();}
 }finally{f.sqlite.close();}});

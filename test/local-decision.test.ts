import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { LocalDecision } from './reference/jev.js';
import { decision } from './reference/core.js';
import { saveSource } from './reference/store.js';
import { fixture, mockFetch } from './helpers.js';

const context = {} as ExecutionContext;
test('real Rust/WASM returns every matching passage with zero Decision calls', async () => {
  const {env,sqlite} = fixture();
  let aiCalls=0;
  env.AI={run:async()=>{aiCalls++;throw new Error('No external inference allowed');}} as unknown as Ai;
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/MobileApp','App','main')");
  for(let i=0;i<41;i++) await saveSource(env,{id:`TrainLCD/MobileApp#${i}`,repo:'TrainLCD/MobileApp',kind:'issue',title:`GPS background tracking ${i}`,
    body:`バックグラウンドの位置情報を継続して取得する。ケース${i}。`,url:`https://github.com/TrainLCD/MobileApp/issues/${i}`,metadata:{},updated_at:'2026-11-12'});
  await saveSource(env,{id:'unrelated',repo:'TrainLCD/MobileApp',kind:'issue',title:'テーマの色',body:'ボタンの配色を青色に変更する。',url:'https://example.test',metadata:{},updated_at:'2026-11-12'});
  const restore=mockFetch(()=>{throw new Error('Authenticated scope should require no network');});
  try {
    const response=await worker.fetch!(new Request('https://example.test/search',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${env.API_TOKEN}`},body:JSON.stringify({query:'バックグラウンドの測位'})}),env,context);
    assert.equal(response.status,200);
    const result=await response.json() as {hit_count:number;evidence:{id:string}[];trace:{calls:number}[];retrieval:string};
    assert.equal(result.hit_count,41);assert.equal(new Set(result.evidence.map(e=>e.id)).size,41);
    assert.ok(result.trace.every(t=>t.calls===0));assert.equal(result.retrieval,'rust-rules-v1');assert.equal(aiCalls,0);
  } finally {restore();sqlite.close();}
});

test('answer SSE preserves sources/draft/result and returns evidence without ticket summaries when verification rejects the answer', async()=>{
  const {env,sqlite}=fixture();
  sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/MobileApp','App','main')");
  await saveSource(env,{id:'one',repo:'TrainLCD/MobileApp',kind:'issue',title:'GPS位置情報',body:'バックグラウンドでは位置を更新しない。',url:'https://example.test',metadata:{},updated_at:'today'});
  const calls:string[]=[];
  env.AI={run:async(model:string)=>{
    calls.push(model);
    const content=JSON.stringify({claims:[{text:'バックグラウンドでは位置を更新する。',citations:['p1']}],summaries:[]});
    return new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n\n'));c.close();}});
  }} as unknown as Ai;
  try{
    const response=await worker.fetch!(new Request('https://example.test/answer',{method:'POST',headers:{'content-type':'application/json',accept:'text/event-stream',authorization:`Bearer ${env.API_TOKEN}`},body:JSON.stringify({query:'バックグラウンドの位置情報'})}),env,context);
    assert.equal(response.status,200);
    const stream=await response.text();
    assert.ok(stream.indexOf('event: sources')<stream.indexOf('event: draft'));assert.ok(stream.indexOf('event: draft')<stream.indexOf('event: result'));
    const result=JSON.parse(stream.split('event: result\ndata: ')[1]!.trim());
    assert.equal(result.status,'generation_unavailable');assert.equal(result.answer,null);
    assert.equal(result.ticket_summaries,undefined);
    assert.equal(result.evidence.length,1);
    assert.deepEqual(calls,['@cf/google/gemma-4-26b-a4b-it']);
  }finally{sqlite.close();}
});

test('WASM matches native rules, rejects malformed input, and survives repeated allocations',async()=>{
  for(let i=0;i<200;i++){
    const judge=new LocalDecision();
    const hits=await judge.rankPassages('地下鉄で位置更新が止まる問題',[
      {id:'good',description:'Restore GPS location in underground tunnels.'},
      {id:'bad',description:'地下鉄の駅名の翻訳を更新。'}],20);
    assert.deepEqual(hits.map(h=>h.item.id),['good']);
  }
  assert.throws(()=>decision({op:'invalid'}),/invalid_decision_input/);
  assert.deepEqual(await new LocalDecision().score('GPS',[],'test'),[]);
});

test('public scope is checked before real local scoring and private references stay excluded',async()=>{
  const {env,sqlite}=fixture();env.AI=undefined;env.PUBLIC_SEARCH_RATE_LIMIT={limit:async()=>({success:true})} as unknown as RateLimit;
  for(const repo of ['TrainLCD/Public','TrainLCD/Private','TrainLCD/Issues'])sqlite.prepare("INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,'main')").run(repo,'fixture');
  for(const [repo,kind] of [['TrainLCD/Public','issue'],['TrainLCD/Private','issue'],['TrainLCD/Issues','feedback']] as const){
    await saveSource(env,{id:repo+'#1',repo,kind,title:'GPSの位置情報',body:'GPS位置情報を更新する。',url:'https://example.test',metadata:{},updated_at:'today'});
  }
  let publicChecks=0;
  const restore=mockFetch(url=>{
    assert.ok(url.startsWith('https://api.github.com/orgs/TrainLCD/repos'));
    publicChecks++;return Response.json([{full_name:'TrainLCD/Public',private:false,visibility:'public'},{full_name:'TrainLCD/Private',private:true}]);
  });
  try{
    const response=await worker.fetch!(new Request('https://example.test/search',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:'GPS'})}),env,context);
    assert.equal(response.status,200);const result=await response.json() as {evidence:{repo:string}[]};
    assert.deepEqual(result.evidence.map(e=>e.repo),['TrainLCD/Public']);assert.equal(publicChecks,1);
  }finally{restore();sqlite.close();}
});

import { readFileSync,writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import worker from '../dist-test/src/index.js';
import { fixture } from '../dist-test/test/helpers.js';
const {env,sqlite}=fixture();env.AI=undefined;
const passages=JSON.parse(readFileSync('test/fixtures/public-passages.json','utf8'));
for(const repo of new Set(passages.map(p=>p.repo)))sqlite.prepare("INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,'main')").run(repo,'Public captured corpus');
for(const p of passages){
 sqlite.prepare('INSERT OR IGNORE INTO sources(id,repo,kind,title,url,body,metadata,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(p.source_id,p.repo,p.kind,p.title,p.url,passages.filter(x=>x.source_id===p.source_id).map(x=>x.text).join('\n'),JSON.stringify(p.metadata),p.updated_at);
 sqlite.prepare('INSERT INTO passages(id,source_id,ordinal,text) VALUES(?,?,?,?)').run(p.id,p.source_id,p.ordinal,p.text);
}
const runs=[];
for(const query of ['地下鉄で位置更新が止まる問題','ウィジェットの駅番号の表示','バスの乗換案内と音声読み上げ']){
 const times=[];let result;
 for(let i=0;i<11;i++){
  const start=performance.now();const response=await worker.fetch(new Request('https://example.test/search',{method:'POST',headers:{authorization:'Bearer '+env.API_TOKEN,'content-type':'application/json'},body:JSON.stringify({query})}),env,{});
  result=await response.json();if(response.status!==200)throw new Error(JSON.stringify(result));times.push(performance.now()-start);
 }
 times.shift();times.sort((a,b)=>a-b);
 runs.push({query,hit_count:result.hit_count,median_ms:times[5],selected:result.evidence.map(e=>e.id),trace:result.trace});
}
sqlite.close();
const report={scope:'Local API using captured 40-passage corpus and SQLite D1 adapter. Authenticated scope; excludes remote GitHub, D1 latency and generation. Not a production latency comparison.',runs};
writeFileSync('docs/evaluation/rust-local-api.json',JSON.stringify(report,null,2)+'\n');console.log(runs.map(({selected,trace,...r})=>r));

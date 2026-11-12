// Synthetic full-scan budget check; not a relevance-quality benchmark.
import worker from '../dist-test/src/index.js';
import {initSync} from '../generated/worker/worker.js';
import {fixture} from '../dist-test/test/helpers.js';
import {writeFileSync} from 'node:fs';
const results=[];
for(const count of [1000,5000,20000]){
 const {env,sqlite}=fixture();env.AI=undefined;
 sqlite.exec("INSERT INTO repositories(repo,description,default_branch) VALUES('TrainLCD/App','Synthetic','main');BEGIN");
 const source=sqlite.prepare("INSERT INTO sources(id,repo,kind,title,url,body,metadata,updated_at) VALUES(?,'TrainLCD/App','issue',?,'https://example.test',?,'{}','2026-11-12')");
 const passage=sqlite.prepare('INSERT INTO passages(id,source_id,ordinal,text) VALUES(?,?,0,?)');
 for(let i=0;i<count;i++){const id='doc'+String(i).padStart(6,'0');const body=i===count-1?'バックグラウンドのGPS位置情報を更新する。':'ボタンの配色を青色に変更する。';source.run(id,body,body);passage.run(id+':0',id,body);}sqlite.exec('COMMIT');
 const start=performance.now();const response=await worker.fetch(new Request('https://example.test/search',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+env.API_TOKEN},body:JSON.stringify({query:'バックグラウンドのGPS位置情報'})}),env,{});const data=await response.json();
 if(response.status!==200||data.hit_count!==1||data.evidence[0].source_id!=='doc'+String(count-1).padStart(6,'0'))throw Error(JSON.stringify(data));
 results.push({documents:count,elapsed_ms:performance.now()-start,wasm_memory_bytes:initSync().memory.buffer.byteLength,hit_count:data.hit_count,trace:data.trace});sqlite.close();
}
writeFileSync('docs/evaluation/rust-index.json',JSON.stringify({scope:'Synthetic SQLite full scan, one matching tail document, no network/generation, warm isolate, local wall-clock not Workers CPU. WASM linear memory excludes host JS and SQLite.',results},null,2)+'\n');console.log(results.map(({trace,...result})=>result));

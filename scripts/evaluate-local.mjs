import {readFileSync,writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
const corpus=JSON.parse(readFileSync('test/fixtures/public-passages.json','utf8'));
const queries=['地下鉄で位置更新が止まる問題','ウィジェットの駅番号の表示','バスの乗換案内と音声読み上げ','Apple Watchのバス乗換案内','background GPS updates in tunnels','存在しないquuxfeature9000'];
const requests=queries.map(query=>({op:'score',query,candidates:corpus.map(e=>({id:e.id,description:e.title+'\n'+e.text}))}));
const native=spawnSync('target/release/decision-rag',[],{input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',encoding:'utf8'});
if(native.status!==0)throw new Error(native.stderr);
const nativeResults=native.stdout.trim().split('\n').map(JSON.parse);
const module=await WebAssembly.compile(readFileSync('generated/decision_core.wasm'));
const core=new WebAssembly.Instance(module,{}).exports;
const call=input=>{
 const bytes=new TextEncoder().encode(JSON.stringify(input));const p=core.allocate(bytes.length);new Uint8Array(core.memory.buffer,p,bytes.length).set(bytes);
 const packed=core.evaluate(p,bytes.length);const ptr=Number(packed&0xffffffffn),len=Number(packed>>32n);
 try{return JSON.parse(new TextDecoder().decode(new Uint8Array(core.memory.buffer,ptr,len)));}finally{core.release(ptr,len);}
};
const runs=[];
for(let i=0;i<requests.length;i++){
 const times=[];let result;
 for(let n=0;n<21;n++){const start=performance.now();result=call(requests[i]);times.push(performance.now()-start);}
 if(JSON.stringify(result)!==JSON.stringify(nativeResults[i]))throw new Error('Native/WASM mismatch');
 times.shift();times.sort((a,b)=>a-b);
 const hits=result.scores.filter(r=>r.score>0.5);
 runs.push({query:queries[i],candidates:corpus.length,hits:hits.length,median_wasm_ms:times[Math.floor(times.length/2)],p95_wasm_ms:times[Math.ceil(times.length*.95)-1],selected:hits,missed:result.scores.filter(r=>r.score<=.5).map(r=>({id:r.id,score:r.score,missing:r.missing}))});
}
const report={engine:'rust-rules-v1',fixture:'test/fixtures/public-passages.json',scope:'40 public passages: union of two current production search result sets, plus PR 7403. Selection-biased corpus; not a full recall/precision evaluation. Timings are scoring only, excluding D1/GitHub/generation.',native_wasm_equal:true,runs};
writeFileSync('docs/evaluation/rust-local.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(runs.map(({selected,missed,...r})=>r),null,2));

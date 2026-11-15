import { readFileSync,writeFileSync } from 'node:fs';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw Error('Usage: summarize.mjs INPUT.json OUTPUT.json');
const report=JSON.parse(readFileSync(input,'utf8'));
if(report.model_mode!=='real')throw Error('Cannot score mocked model results');
const quantile=(values,p)=>{const v=values.toSorted((a,b)=>a-b);return v[Math.max(0,Math.ceil(p*v.length)-1)]??null;};
const rows=report.results;
const metrics=(engine,group)=>{
 const r=rows.filter(x=>x.engine===engine&&(!group||x.group===group));const normal=r.filter(x=>x.mode==='normal');const positive=normal.filter(x=>x.required_count>0);
 const denominator=positive.reduce((n,x)=>n+x.required_count,0);
 return {runs:r.length,normal_runs:normal.length,errors:normal.filter(x=>x.status!==200).length,required_facts:denominator,recalled_facts:positive.reduce((n,x)=>n+x.recalled_count,0),fact_recall:denominator?positive.reduce((n,x)=>n+x.recalled_count,0)/denominator:null,unrelated_at_10:normal.length?normal.reduce((n,x)=>n+x.unrelated_at_10,0)/normal.length:null,false_zero:positive.filter(x=>x.empty_with_evidence).length,negative_false_positive:normal.filter(x=>!x.required_count&&x.hits>0).length,leaks:r.filter(x=>x.leaked).length,mandatory_failures:normal.filter(x=>x.mandatory&&(x.status!==200||x.recalled_count!==x.required_count||(!x.required_count&&x.hits!==0))).map(x=>({id:x.id,run:x.run,missing:x.missing,hits:x.hits,status:x.status})),fault_control_failures:engine==='jev'?r.filter(x=>x.mode!=='normal'&&!x.control_pass).length:null,p50_ms:quantile(normal.map(x=>x.elapsed_ms),.5),p95_ms:quantile(normal.map(x=>x.elapsed_ms),.95),model_calls:r.reduce((n,x)=>n+x.model_calls,0),input_tokens:r.reduce((n,x)=>n+x.input_tokens,0),output_tokens:r.reduce((n,x)=>n+x.output_tokens,0)};
};
const baseline=metrics('rust-rules-v1');const jev=metrics('jev');
const unique=new Set(rows.map(x=>x.id));const complete=unique.size===(report.split==='all'?40:20)&&[...unique].every(id=>['rust-rules-v1','jev'].every(e=>rows.filter(x=>x.id===id&&x.engine===e).length===3));
const gates={complete,normal_requests_succeed:jev.errors===0,mandatory_recall:jev.mandatory_failures.length===0,no_leaks:jev.leaks===0,no_error_as_empty:jev.fault_control_failures===0,recall_not_worse:jev.fact_recall>=baseline.fact_recall,unrelated_within_five_points:jev.unrelated_at_10<=baseline.unrelated_at_10+.05};
const summary={split:report.split,commit:report.commit,corpus_sha256:report.corpus_sha256,questions_sha256:report.questions_sha256,baseline,jev,groups:Object.fromEntries(['A','B','C','D','E'].map(g=>[g,{baseline:metrics('rust-rules-v1',g),jev:metrics('jev',g)}])),gates,pass:Object.values(gates).every(Boolean)};
writeFileSync(output,JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));

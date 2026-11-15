import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { UsageLedger } from './usage.mjs';
import worker from '../../dist-test/src/index.js';
import { fixture, mockFetch } from '../../dist-test/test/helpers.js';
const corpusBytes = readFileSync('test/fixtures/jev-evaluation/corpus.json');
const questionsBytes = readFileSync(process.env.EVALUATION_QUESTIONS ?? 'test/fixtures/jev-evaluation/questions.json');
const corpus = JSON.parse(corpusBytes); const questions = JSON.parse(questionsBytes).questions;
const proxy = process.env.EVALUATION_PROXY; const token = process.env.EVALUATION_TOKEN;
const split = process.env.EVALUATION_SPLIT ?? 'all';
if (!proxy || !token) throw Error('Evaluation proxy configuration is required');
const dryRun = process.env.EVALUATION_DRY_RUN === '1';
const transport = dryRun ? async (_url, init) => {
  const body=JSON.parse(init.body);
  return Response.json({model:'jev-1.14.0',usage:{input_tokens:0,output_tokens:0},answers:Object.fromEntries(Object.keys(body.state.candidates).map(id=>[id,{type:'noul',noul:0.01}]))});
} : globalThis.fetch;
const report = { version: 1, model_mode: dryRun ? "mock-plumbing-only" : "real", commit: process.env.GITHUB_SHA ?? 'local', corpus_sha256: createHash('sha256').update(corpusBytes).digest('hex'), questions_sha256: createHash('sha256').update(questionsBytes).digest('hex'), recorded_at: new Date().toISOString(), split, expected_question_ids: questions.filter(q => split === "all" || q.split === split).map(q => q.id), results: [] };
mkdirSync('evaluation-results', { recursive: true });
for (const q of questions.filter(q => (split === 'all' || q.split === split) && (!process.env.EVALUATION_QUESTION_ID || q.id === process.env.EVALUATION_QUESTION_ID))) for (let run = 1; run <= 3; run++) for (const engine of ['rust-rules-v1', 'jev']) {
  const f = fixture(); f.env.RETRIEVAL_ENGINE = engine; f.env.TYPESAFE_API_KEY = 'evaluation-host-placeholder'; f.env.AI = undefined;
  const repos = [...new Set(corpus.map(p => p.repo))]; const publicRepos = repos.filter(r => r !== 'TrainLCD/EvaluationPrivate');
  for (const repo of repos) f.sqlite.prepare('INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,?)').run(repo, repo, 'main');
  const sources = Map.groupBy(corpus, p => p.source_id);
  for (const [id, passages] of sources) {
    passages.sort((a,b) => a.ordinal - b.ordinal); const p = passages[0];
    f.sqlite.prepare('INSERT INTO sources(id,repo,kind,title,url,body,metadata,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,p.repo,p.kind,p.title,p.url,passages.map(p=>p.text).join('\n\n'),JSON.stringify(p.metadata??{}),p.updated_at??'2026-11-15');
    for (const p of passages) f.sqlite.prepare('INSERT INTO passages(id,source_id,ordinal,text) VALUES(?,?,?,?)').run(p.id,id,p.ordinal,p.text);
  }
  const selected = new Set(); const db = f.env.DB;
  f.env.DB = { ...db, prepare(sql) { const stmt = db.prepare(sql); const bind = stmt.bind.bind(stmt); stmt.bind = (...values) => { if (sql.includes('FROM passages') && sql.includes('json_each(?)')) { try { const ids = JSON.parse(values[0]); if (Array.isArray(ids)) for (const id of ids) selected.add(id); } catch {} } return bind(...values); }; return stmt; } };
  const requiredSources = q.required_groups.flat().map(id => corpus.find(p => p.id === id)?.source_id).filter(Boolean);
  const decisionSamples = [];
  let modelCalls=0, leaked=false; const usage = new UsageLedger();
  const restore = mockFetch(async (url, init) => {
    if (url.startsWith('https://api.github.com/')) return Response.json(publicRepos.map(full_name => ({full_name, private:false, visibility:'public'})));
    if (url !== 'https://api.typesafe.ai/v1/systemone') throw Error('Unexpected evaluation destination');
    modelCalls++;
    if (String(init.body).includes('PRIVATE_ORION_MARKER')) { leaked=true; throw Error('Private fixture leaked'); }
    if (q.mode === 'outage') return new Response('unavailable', { status: 500 });
    if (q.mode === 'malformed') return Response.json({model:'jev-1.14.0',usage:{input_tokens:1,output_tokens:1},answers:{}});
    let response;
    try { response = await transport(proxy+'/judge', { method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:init.body,signal:AbortSignal.timeout(40000) }); }
    catch (error) { usage.failure(); throw error; }
    await usage.response(response);
    try {
    if (q.mandatory && q.mode === 'normal' && response.ok) {
      const request = JSON.parse(String(init.body));
      const reply = await response.clone().json();
      for (const [id, description] of Object.entries(request.state.candidates)) {
        if (requiredSources.some(source => String(description).includes(`source=${source};`))) {
          decisionSamples.push({stage: (Object.values(request.questions)[0].instructions.includes('specific subject') || Object.values(request.questions)[0].instructions.includes('domain/identity check')) ? 'subject' : Object.values(request.questions)[0].instructions.includes('collection\'s membership') ? 'collection' : 'relevance', candidate: description, score: reply.answers?.[id]?.noul ?? null});
        }
      }
    }
    } catch { /* Diagnostics must not change provider response handling. */ }
    return response;
  });
  const start=performance.now();
  try {
    const response=await worker.fetch(new Request('https://evaluation.invalid/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:q.query})}), {...f.env,PUBLIC_SEARCH_RATE_LIMIT:{limit:async()=>({success:true})}}, {});
    const data=await response.json(); const ids=(data.evidence??[]).map(p=>p.id); const relevant=new Set(q.relevant_ids);
    const missing=q.required_groups.filter(group=>!group.some(id=>ids.includes(id)));
    const missingStages=missing.map(group=>({ids:group,stage:group.some(id=>selected.has(corpus.find(p=>p.id===id)?.source_id))?'passage_scoring':'document_selection'}));
    const top=ids.slice(0,10); const falseTop=top.filter(id=>!relevant.has(id));
    const fault=q.mode!=='normal';
    const record={id:q.id,group:q.group,split:q.split,query:q.query,run,engine,status:response.status,error:data.error??null,model_calls:modelCalls,leaked,elapsed_ms:performance.now()-start,hits:data.hit_count??null,ids,required_count:q.required_groups.length,recalled_count:q.required_groups.length-missing.length,missing:missingStages,unrelated_at_10:top.length?falseTop.length/top.length:0,unrelated_ids:falseTop,empty_with_evidence:q.required_groups.length>0&&response.status===200&&data.hit_count===0,mandatory:q.mandatory,mode:q.mode,control_pass: fault ? engine==='jev'&&response.status===502&&data.hit_count===undefined : null,...usage.snapshot()};
    report.results.push(record); console.log(JSON.stringify(record));
    if (missing.length && q.mandatory) console.log(JSON.stringify({diagnostic_question:q.id,run,decision_samples:decisionSamples}));
  } finally {restore();f.sqlite.close();writeFileSync('evaluation-results/'+split+'.json',JSON.stringify(report,null,2)+'\n');}
}

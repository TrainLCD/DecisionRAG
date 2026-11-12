#!/usr/bin/env python3
"""Serial, alternating comparisons; records failures and corpus revisions verbatim."""
import argparse, datetime, hashlib, json, pathlib, time, urllib.request, urllib.error
p=argparse.ArgumentParser()
p.add_argument('--base-url',required=True)
p.add_argument('--commit',required=True)
p.add_argument('--split',choices=['development','holdout'],default='development')
p.add_argument('--questions',default='docs/evaluation/flash-questions-2026-11-12.json')
p.add_argument('--output',required=True)
a=p.parse_args()
out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True)
raw=pathlib.Path(a.questions).read_bytes(); dataset=json.loads(raw)
questions=[q for q in dataset['questions'] if q['split']==a.split]
def http(path,body=None):
 data=None if body is None else json.dumps(body,ensure_ascii=False).encode()
 req=urllib.request.Request(a.base_url.rstrip('/')+path,data=data,headers={'Content-Type':'application/json','User-Agent':'DecisionRAG-evaluation/1.0'})
 start=time.perf_counter();status=None
 try:
  with urllib.request.urlopen(req,timeout=120) as r: status=r.status; content=r.read().decode()
 except urllib.error.HTTPError as e: status=e.code;content=e.read().decode()
 except Exception as e: return {'http_status':status,'client_ms':round((time.perf_counter()-start)*1000),'error':type(e).__name__}
 try: parsed=json.loads(content)
 except ValueError: parsed={'error':'non_json_response'}
 return {'http_status':status,'client_ms':round((time.perf_counter()-start)*1000),'response':parsed}
def revision():
 result=http('/evaluation/revision')
 if result['http_status']!=200 or 'revision' not in result.get('response',{}):raise RuntimeError('corpus fingerprint unavailable: '+json.dumps(result))
 return result['response']
def append(name,row):
 with (out/name).open('a') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
start=revision()
needed={e['source_id'] for q in questions for f in q['required_facts'] for alt in f['acceptable_evidence_sets'] for e in alt}
missing=needed-set(start['source_ids'])
if missing:raise RuntimeError('ground truth source absent: '+str(missing))
meta={'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'commit':a.commit,'base_url':a.base_url,'split':a.split,'question_sha256':hashlib.sha256(raw).hexdigest(),'initial_snapshot':start,'warmup':'one separate query per model, excluded; no retries removed','request':{'include_feedback':False,'paginated':False},'order':'AB, BA alternating across question/repetition pairs; serial','repetitions':3}
(out/'manifest.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
for model in ['clef','clef-flash']:
 row={'model':model,**http('/search?passage_model='+model,{'query':'StationAPIはどのようなAPI？','include_feedback':False,'paginated':False})}
 append('warmup.jsonl',row);print('warmup',model,row['http_status'],row['client_ms'],flush=True)
for rep in range(3):
 for i,q in enumerate(questions):
  order=['clef','clef-flash'] if (rep*len(questions)+i)%2==0 else ['clef-flash','clef']
  before=revision(); rows=[]
  for model in order:
   row={'id':q['id'],'repetition':rep+1,'model':model,'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),**http('/search?passage_model='+model,{'query':q['query'],'include_feedback':False,'paginated':False})}
   # Save each request immediately; a later snapshot failure cannot erase it.
   append('requests.jsonl',row);rows.append(row)
   print(q['id'],rep+1,model,row['http_status'],row['client_ms'],row.get('response',{}).get('hit_count'),flush=True)
  after=revision()
  append('pairs.jsonl',{'id':q['id'],'repetition':rep+1,'before':before['revision'],'after':after['revision'],'valid':before['revision']==after['revision'],'order':order})
print('complete',flush=True)

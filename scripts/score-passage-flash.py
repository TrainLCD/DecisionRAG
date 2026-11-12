#!/usr/bin/env python3
"""Score pooled passage annotations; never equate source presence with fact coverage."""
import argparse,collections,hashlib,json,pathlib,statistics
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--questions',default='docs/evaluation/flash-questions-2026-11-12.json');p.add_argument('--labels',required=True);a=p.parse_args()
d=pathlib.Path(a.directory);questions={q['id']:q for q in json.load(open(a.questions))['questions']};labels=json.load(open(a.labels))['annotations']
rows=[json.loads(x) for x in (d/'requests.jsonl').read_text().splitlines()];pairs={(r['id'],r['repetition']):r for r in map(json.loads,(d/'pairs.jsonl').read_text().splitlines())}
scored=[];unlabelled=set()
def score_evidence(q,items,require_all_labels=True):
 facts=set();seen=set();unrelated=duplicates=0;missing=[]
 for e in items:
  label=labels.get(q['id'],{}).get(e['id'])
  if not label:missing.append((q['id'],e['id']));continue
  digest=hashlib.sha256(json.dumps([e['title'],e['text'],e['metadata']],sort_keys=True,ensure_ascii=False).encode()).hexdigest()
  if label['sha256']!=digest:raise ValueError('passage version differs from annotation: '+e['id'])
  facts.update(label['facts']);unrelated+=not label['relevant']
  info=set(label['information'])
  if label['relevant'] and info and info<=seen:duplicates+=1
  seen.update(info)
 required={f['id'] for f in q['required_facts']}
 if require_all_labels or not required<=facts:unlabelled.update(missing)
 return {'facts':sorted(facts & required),'complete':bool(required) and required<=facts,'fact_coverage':len(facts&required)/len(required) if required else None,'unrelated_fraction':unrelated/len(items) if items else None,'duplicate_slots':duplicates}
for r in rows:
 q=questions[r['id']];res=r.get('response',{});pair=pairs.get((r['id'],r['repetition']),{})
 valid=pair.get('valid',False);success=r.get('http_status')==200 and res.get('status') in ['retrieved','empty']
 scored.append({'id':r['id'],'repetition':r['repetition'],'model':r['model'],'valid_pair':valid,'success':success,'client_ms':r['client_ms'],'server_ms':res.get('elapsed_ms'),'error':r.get('error') or res.get('error'),'at10':score_evidence(q,res.get('evidence',[])[:10]),'all':score_evidence(q,res.get('evidence',[]),False)})
if unlabelled:raise ValueError('unlabelled evidence: '+str(sorted(unlabelled)))
summary=[];losses=[]
for qid in sorted({r['id'] for r in rows}):
 q=questions[qid];entry={'id':qid,'critical':q['critical'],'answerability':q['answerability']}
 for model in ['clef','clef-flash']:
  rs=[r for r in scored if r['id']==qid and r['model']==model and r['valid_pair']];ok=[r for r in rs if r['success']]
  entry[model]={'requests':len(rs),'errors':len(rs)-len(ok),'complete10':sum(r['at10']['complete'] and r['success'] for r in rs),'complete_all':sum(r['all']['complete'] and r['success'] for r in rs),'client_median_ms':statistics.median(r['client_ms'] for r in ok) if ok else None,'server_median_ms':statistics.median(r['server_ms'] for r in ok) if ok else None,'fact_coverage':statistics.mean(r['at10']['fact_coverage'] or 0 for r in rs) if q['required_facts'] and rs else None,'unrelated_fraction':statistics.mean(x) if (x:=[r['at10']['unrelated_fraction'] for r in ok if r['at10']['unrelated_fraction'] is not None]) else None,'duplicate_slots':statistics.mean(r['at10']['duplicate_slots'] for r in ok) if ok else None}
 if all(entry[m]['client_median_ms'] for m in ['clef','clef-flash']):
  entry['client_ratio']=entry['clef-flash']['client_median_ms']/entry['clef']['client_median_ms'];entry['saved_ms']=entry['clef']['client_median_ms']-entry['clef-flash']['client_median_ms']
 if q['critical'] and q['required_facts']:
  for rep in range(1,4):
   ra=next((r for r in scored if r['id']==qid and r['model']=='clef' and r['repetition']==rep and r['valid_pair']),None);rb=next((r for r in scored if r['id']==qid and r['model']=='clef-flash' and r['repetition']==rep and r['valid_pair']),None)
   if ra and rb and (lost:=set(ra['at10']['facts'])-set(rb['at10']['facts'])):losses.append({'id':qid,'repetition':rep,'facts':sorted(lost)})
 summary.append(entry)
result={'questions':summary,'critical_fact_losses':losses,'scored_requests':scored,'invalid_pairs':[r for r in pairs.values() if not r['valid']],'all_requests':len(rows),'errors':sum(not r['success'] for r in scored),'median_client_ratio':statistics.median(r['client_ratio'] for r in summary if 'client_ratio' in r),'median_saved_ms':statistics.median(r['saved_ms'] for r in summary if 'saved_ms' in r)}
print(json.dumps(result,ensure_ascii=False,indent=2))

import argparse,json,statistics,collections,pathlib
p=argparse.ArgumentParser();p.add_argument('directory');p.add_argument('--summary',required=True);a=p.parse_args()
base=pathlib.Path(a.directory)
s=json.load(open(a.summary))
rows=[json.loads(x) for x in (base/'requests.jsonl').read_text().splitlines()]
summary={}
for m in ['clef','clef-flash']:
 qs=[q for q in s['questions'] if q['answerability']=='answerable']
 allq=s['questions'];sr=[r for r in s['scored_requests'] if r['model']==m and r['valid_pair']];ar=[r for r in sr if r['id'] in {q['id'] for q in qs}]
 usage=collections.defaultdict(lambda:dict(calls=0,input_tokens=0,output_tokens=0));stages=collections.defaultdict(list)
 for row in rows:
  if row['model']!=m:continue
  for st in row.get('response',{}).get('trace',[]):
   stages[st['stage']].append(st['elapsed_ms'])
   mu=st.get('model_usage') or {st['model'][0]:{k:st[k] for k in ['calls','input_tokens','output_tokens']}}
   for model,u in mu.items():
    for k in u:usage[model][k]+=u[k]
 passage=[st for row in rows if row['model']==m for st in row.get('response',{}).get('trace',[]) if st['stage']=='passage_scoring']
 summary[m]={'valid_requests':len(sr),'errors':sum(not r['success'] for r in sr),'answerable_requests':len(ar),'complete10_requests':sum(r['at10']['complete'] and r['success'] for r in ar),'complete_all_requests':sum(r['all']['complete'] and r['success'] for r in ar),'stable10_questions':sum(q[m]['complete10']>=2 for q in qs),'answerable_questions':len(qs),'question_mean_fact_coverage':statistics.mean(q[m]['fact_coverage'] for q in qs),'question_mean_unrelated':statistics.mean(q[m]['unrelated_fraction'] for q in qs if q[m]['unrelated_fraction'] is not None),'question_mean_duplicate_slots':statistics.mean(q[m]['duplicate_slots'] for q in qs if q[m]['duplicate_slots'] is not None),'median_question_client_ms':statistics.median(q[m]['client_median_ms'] for q in allq if q[m]['client_median_ms']),'median_question_server_ms':statistics.median(q[m]['server_median_ms'] for q in allq if q[m]['server_median_ms']),'median_stage_ms':{k:statistics.median(v) for k,v in stages.items()},'usage_successful_requests_only':dict(usage),'passage_calls_successful_requests_only':sum(p['calls'] for p in passage),'passage_flash_calls_successful_requests_only':sum(p.get('model_usage',{}).get('clef-flash',{}).get('calls',0) for p in passage),'passage_flash_fallbacks_successful_requests_only':sum(p.get('flash_fallbacks',0) for p in passage)}
summary['median_question_client_ratio']=s['median_client_ratio'];summary['median_saved_ms']=s['median_saved_ms'];summary['median_question_server_ratio']=statistics.median(q['clef-flash']['server_median_ms']/q['clef']['server_median_ms'] for q in s['questions'] if q['clef-flash']['server_median_ms'] and q['clef']['server_median_ms']);summary['critical_losses']=s['critical_fact_losses'];summary['invalid_pairs']=s['invalid_pairs']
summary['noncritical_stable_losses']=[q['id'] for q in s['questions'] if not q['critical'] and q['answerability']=='answerable' and q['clef']['complete10']>=2 and q['clef-flash']['complete10']<2]
summary['over_20_percent_slower']=[q['id'] for q in s['questions'] if q.get('client_ratio',0)>1.2]
summary['distinct_revisions']=sorted({v for row in map(json.loads,(base/'pairs.jsonl').read_text().splitlines()) for v in [row['before'],row['after']]})
summary['errors']=[{k:v for k,v in r.items() if k!='response'}|{'response':r.get('response')} for r in rows if r['http_status']!=200]
print(json.dumps(summary,ensure_ascii=False,indent=2))

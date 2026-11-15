import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jev-rescore-'));
  const input=join(dir,'input.json'), original=join(dir,'original.json'), questions=join(dir,'questions.json'), output=join(dir,'output.json');
  const q={id:'A2',query:'watch',required_groups:[['watch']],relevant_ids:['watch','phone']};
  const originalText=JSON.stringify({questions:[q]});
  const hash=createHash('sha256').update(originalText).digest('hex');
  const row={id:'A2',query:'watch',mode:'normal',ids:['watch','phone'],required_count:1,recalled_count:1,unrelated_at_10:0};
  writeFileSync(original,originalText);
  writeFileSync(input,JSON.stringify({questions_sha256:hash,results:[row]}));
  const annotations={label_correction:'phone is not watch',questions:[{...q,relevant_ids:['watch']}]};
  writeFileSync(questions,JSON.stringify(annotations));
  return {dir,input,original,questions,output,row,hash,annotations,run:(path=output)=>execFileSync(process.execPath,['scripts/evaluation/rescore.mjs',input,original,questions,path],{stdio:'pipe'})};
}

test('correction removes false relevance while preserving retrievals and original report', () => {
  const f=fixture();
  try {
    f.run();
    const corrected=JSON.parse(readFileSync(f.output));
    assert.equal(corrected.results[0].unrelated_at_10,0.5);
    assert.deepEqual(corrected.results[0].ids,f.row.ids);
    assert.equal(JSON.parse(readFileSync(f.input)).results[0].unrelated_at_10,0);
    assert.equal(corrected.rescored_from.questions_sha256,f.hash);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});

test('rescore rejects equivalent paths, symlinks and hard links without changing input', () => {
  const f=fixture();
  try {
    const original=readFileSync(f.input,'utf8');
    symlinkSync(f.input,join(f.dir,'symbolic.json'));
    linkSync(f.input,join(f.dir,'hard.json'));
    for(const path of [f.dir+'/./input.json',join(f.dir,'symbolic.json'),join(f.dir,'hard.json')])assert.throws(()=>f.run(path));
    assert.equal(readFileSync(f.input,'utf8'),original);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});

test('same recall count does not permit changing the identity of required facts', () => {
  const f=fixture();
  try {
    f.annotations.questions[0].required_groups=[['phone']];
    f.annotations.questions[0].relevant_ids=['phone'];
    writeFileSync(f.questions,JSON.stringify(f.annotations));
    assert.throws(()=>f.run(),/Required facts/);
  } finally {rmSync(f.dir,{recursive:true,force:true});}
});

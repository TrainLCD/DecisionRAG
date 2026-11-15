import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');
const cases = JSON.parse(read('test/fixtures/answer-topic/cases.json'));
const model = '@cf/google/gemma-4-26b-a4b-it';
const endpoint = process.env.ANSWER_EVALUATION_URL;
if (!endpoint || !/^http:\/\/127\.0\.0\.1:\d+\/run$/.test(endpoint)) throw new Error('Local evaluation Worker URL is required');
const report = { model, scope: 'Fixed public issue/PR excerpts plus synthetic example-only distractor. Citation checks do not establish semantic correctness; inspect recorded answers.', runs: [] };
mkdirSync('test-results', { recursive: true });
const save = () => writeFileSync('test-results/answer-topic.json', JSON.stringify(report, null, 2) + '\n');
try {
  for (const variant of ['baseline', 'candidate']) {
    const instructions = read(variant === 'baseline' ? 'test/fixtures/answer-topic/baseline-instructions.txt' : 'backend/src/instructions.txt');
    for (const test of cases) for (let repetition = 1; repetition <= 3; repetition++) {
      const ids = test.evidence.map(p => p.citation);
      const start = performance.now();
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(120000),
        body: JSON.stringify({ messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify({query: test.query, evidence: test.evidence, evidence_scope: {retrieved_passages: test.retrieved_passages ?? ids.length, included_passages: ids.length, exhaustive: false}}) + '\n\n' + read('backend/src/writingGuide.txt') }], max_completion_tokens: 3000, temperature: 0, chat_template_kwargs: { enable_thinking: false }, response_format: { type: 'json_schema', json_schema: { name: 'cited_claims', strict: true, schema: {type: 'object', additionalProperties: false, required: ['claims'], properties: {claims: {type: 'array', maxItems: 3, items: {type: 'object', additionalProperties: false, required: ['text','citations'], properties: {text:{type:'string'}, citations:{type:'array',minItems:1,maxItems:3,items:{type:'string',enum:ids}}}}}}} } } })
      });
      if (!response.ok) throw new Error(`Evaluation HTTP ${response.status}`);
      const result = await response.json();
      const raw = result?.response ?? result?.choices?.[0]?.message?.content;
      const answer = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(answer?.claims)) throw new Error('Malformed evaluation answer');
      const citations = answer.claims.flatMap(c => c.citations ?? []);
      const passed = answer.claims.length >= (test.minimum_claims ?? 0) && answer.claims.every(c => typeof c.text === 'string' && c.text.trim() && Array.isArray(c.citations) && c.citations.length > 0 && c.citations.every(id => test.allowed.includes(id))) && test.required.every(id => citations.includes(id)) && (test.allowed.length > 0 || answer.claims.length === 0);
      report.runs.push({ variant, case: test.name, repetition, elapsed_ms: performance.now() - start, passed, answer });
      save();
      console.log(`${variant} ${test.name} ${repetition}: ${passed ? 'PASS' : 'FAIL'}`);
    }
  }
} finally { save(); }
if (report.runs.filter(r => r.variant === 'candidate').some(r => !r.passed)) process.exitCode = 1;

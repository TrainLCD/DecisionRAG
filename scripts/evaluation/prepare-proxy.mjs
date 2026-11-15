import { readFileSync,writeFileSync } from 'node:fs';
const config=JSON.parse(readFileSync('wrangler.jsonc','utf8'));
config.main='scripts/evaluation/model-proxy.ts';config.preview_urls=true;config.keep_vars=true;
for(const key of ['vars','queues','triggers','routes','route','assets','d1_databases','ai','ratelimits','unsafe'])delete config[key];
config.vars={EVALUATION_TOKEN:process.env.EVALUATION_TOKEN,EVALUATION_EXPIRES:String(Date.now()+90*60000)};
config.build={command:'echo evaluation-proxy'};
writeFileSync('wrangler.evaluation.json',JSON.stringify(config));

import { readFileSync, writeFileSync } from 'node:fs';

export function previewConfig(config, databaseId) {
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId ?? '')
      || databaseId === '00000000-0000-0000-0000-000000000000') {
    throw new Error('Set DECISIONRAG_D1_DATABASE_ID to the existing production D1 database ID.');
  }
  const result = structuredClone(config);
  result.main = 'src/preview.ts';
  result.preview_urls = true;
  result.keep_vars = true;
  delete result.vars;
  delete result.queues;
  delete result.triggers;
  delete result.routes;
  delete result.route;
  const database = result.d1_databases.find(({ binding }) => binding === 'DB');
  if (!database) throw new Error('Missing DB binding');
  database.database_id = databaseId;
  return result;
}

if (process.argv[1]?.endsWith('/prepare-preview.mjs')) {
  const config = previewConfig(JSON.parse(readFileSync('wrangler.jsonc', 'utf8')), process.env.DECISIONRAG_D1_DATABASE_ID);
  writeFileSync('wrangler.preview.json', JSON.stringify(config, null, 2));
}

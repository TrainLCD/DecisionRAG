import preview from './preview.js';
import type { Env, SyncJob } from './types.js';
export default { ...preview, fetch(request, env, ctx) { return preview.fetch!(request, { ...env, SCREENING_MODEL: 'clef' }, ctx); } } satisfies ExportedHandler<Env, SyncJob>;

import { branches, DOCUMENT_PAGE_SIZE, documentPages, documentsFor, passagesFor, type Branch, type DocumentCursor, type SearchScope } from './store.js';
import type { Judge } from './jev.js';
import { boundedNumber, HttpError, type Candidate, type Env, type Passage } from './types.js';
export interface RetrievalStore {
  documents(limit: number): Promise<Candidate[]>;
  branches(): Promise<Branch[]>;
  documentPages(cursors: DocumentCursor[]): Promise<Candidate[][]>;
  passages(ids: string[], limit: number): Promise<Passage[]>;
}
export interface Budgets { branches: number; documents: number; passages: number; maxDocuments: number; maxPassages: number }
export const DEFAULT_BUDGETS: Budgets = { branches: 6, documents: 30, passages: 20, maxDocuments: 20_000, maxPassages: 4000 };
const directDocumentLimit = 5_000;
/** Load D1 candidates while the public scope is checked, then filter before scoring. */
export function d1Store(env: Env, scope?: Promise<SearchScope>, timings = { storage_ms: 0 }): RetrievalStore {
  async function measure<T>(operation: Promise<T>): Promise<T> {
    const start = Date.now();
    try { return await operation; }
    finally { timings.storage_ms += Date.now() - start; }
  }
  return {
    documents: async limit => measure(documentsFor(env, limit, await scope)),
    async branches() {
      // Wait for the fresh allowlist before exposing candidates to the judge.
      const [roots, allowed] = await Promise.all([measure(branches(env)), scope]);
      if (!allowed) return roots;
      const publicRepos = new Set(allowed.publicRepos);
      return roots.filter(root => root.kind === 'feedback'
        ? root.repo.toLowerCase() === allowed.feedbackRepo
        : publicRepos.has(root.repo.toLowerCase()));
    },
    documentPages: cursors => measure(documentPages(env, cursors)),
    passages: async (ids, limit) => measure(passagesFor(env, ids, limit, await scope)),
  };
}
export interface Evidence extends Passage { citation: string; relevance: number }
interface RetrievalResult { evidence: Evidence[]; hitCount: number }
/** Route large collections by repository and source type before scanning their titles. */
async function routedDocuments(query: string, store: RetrievalStore, judge: Judge, budget: Budgets): Promise<Candidate[]> {
  const roots = await store.branches();
  const selected = (await judge.score(query, roots, 'branch_screening')).slice(0, budget.branches);
  let screened = 0;
  // No lexical/vector prefilter: every document title in each retained branch is evaluated.
  const branchesToScreen = selected.map(({ item }) => ({ branch: item, after: '', documents: [] as Candidate[] }));
  let pending = branchesToScreen;
  while (pending.length) {
    const pages = await store.documentPages(pending);
    pending = pending.filter((state, i) => {
      const page = pages[i]!;
      if (!page.length) return false;
      screened += page.length;
      if (screened > budget.maxDocuments) throw new HttpError(422, 'document_screening_budget_exceeded');
      state.documents.push(...page);
      const cursor = page.at(-1)!.id;
      if (cursor <= state.after) throw new HttpError(503, 'invalid_document_cursor');
      state.after = cursor;
      return page.length === DOCUMENT_PAGE_SIZE;
    });
  }
  return branchesToScreen.flatMap(state => state.documents);
}

/** Let Jev screen titles and then passages, routing only when the collection is too large. */
export async function retrieve(query: string, store: RetrievalStore, judge: Judge, budget: Budgets = DEFAULT_BUDGETS): Promise<RetrievalResult> {
  const directLimit = Math.min(directDocumentLimit, Math.floor(budget.maxDocuments));
  const direct = await store.documents(directLimit + 1);
  const documents = direct.length <= directLimit ? direct : await routedDocuments(query, store, judge, budget);
  const documentScores = await judge.score(query, documents, 'document_screening');
  // Keep the strongest candidates even when title-level scores are uncertain.
  const selectedDocs = documentScores.filter((r, index) => index < budget.documents || r.probability > 0.5).map(r => r.item.id);
  const passages = await store.passages(selectedDocs, budget.maxPassages + 1);
  if (passages.length > budget.maxPassages) throw new HttpError(422, 'passage_screening_budget_exceeded');
  const candidates = passages.map(p => ({ ...p,
    description: `${p.title}\nRepository: ${p.repo}\nMetadata: ${JSON.stringify(p.metadata)}\n${p.text}` }));
  const { ranked, hitCount } = await judge.rankPassages(query, candidates, Math.min(20, budget.passages * 2));
  const evidence = ranked.slice(0, budget.passages).map((r, i) => {
    const { description: _, ...passage } = r.item;
    return { ...passage, citation: `p${i + 1}`, relevance: r.probability };
  });
  return { evidence, hitCount };
}
export function gate(env: Env, decision: { supported: number; conflict: number }): 'ready' | 'insufficient_evidence' | 'conflicting_evidence' {
  const support = boundedNumber(env.SUPPORT_THRESHOLD, 0.85, 0, 1);
  const conflict = boundedNumber(env.CONFLICT_THRESHOLD, 0.7, 0, 1);
  if (decision.conflict >= conflict) return 'conflicting_evidence';
  return decision.supported >= support ? 'ready' : 'insufficient_evidence';
}

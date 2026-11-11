import { branches, DOCUMENT_PAGE_SIZE, documentPages, documentsFor, passagesFor, localReferences, type Branch, type DocumentCursor, type SearchScope } from './store.js';
import type { Judge } from './jev.js';
import { boundedNumber, HttpError, type Candidate, type Env, type Passage } from './types.js';
export interface RetrievalStore {
  documents(limit: number): Promise<Candidate[]>;
  branches(): Promise<Branch[]>;
  documentPages(cursors: DocumentCursor[]): Promise<Candidate[][]>;
  passages(ids: string[], limit: number): Promise<Passage[]>;
}
export interface Budgets { branches: number; documents: number; maxDocuments: number; maxPassages: number }
export const DEFAULT_BUDGETS: Budgets = { branches: 6, documents: 30, maxDocuments: 20_000, maxPassages: 4000 };
const directDocumentLimit = 5_000;
const choiceShortlistSize = 20;
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
export interface RetrievalPlan { ids: string[] }
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

/** Select coarse groups using titles and body samples, retaining uncertain groups. */
export async function planRetrieval(query: string, store: RetrievalStore, judge: Judge, budget: Budgets = DEFAULT_BUDGETS): Promise<RetrievalPlan> {
  const directLimit = Math.min(directDocumentLimit, Math.floor(budget.maxDocuments));
  const direct = await store.documents(directLimit + 1);
  let documents = direct.length <= directLimit ? direct : await routedDocuments(query, store, judge, budget);
  const scopedDocuments = documents;
  if (documents.length > 128) {
    const groups = [];
    for (let i = 0; i < documents.length; i += 24) {
      const members = documents.slice(i, i + 24);
      groups.push({ id: `group${i / 24}`, members,
        description: 'A group of documents. Explore if ANY member may contain relevant evidence; body samples are incomplete, so uncertainty is not evidence of irrelevance.\n' +
          members.map((item, index) => `${index + 1}. ${item.overview ?? item.description}`).join('\n\n') });
    }
    const scoredGroups = await judge.score(query, groups, 'page_screening');
    documents = scoredGroups.filter((row, index) => index < 4 || row.probability > 0.2).flatMap(row => row.item.members);
    const groupTrace = judge.trace.at(-1);
    if (groupTrace?.stage === 'page_screening') groupTrace.selected = documents.map(item => item.id);
  }
  const documentScores = await judge.score(query, documents, 'document_screening');
  // Keep the strongest candidates even when their excerpt-level scores are uncertain.
  const selectedDocs = documentScores.filter((r, index) => index < budget.documents || r.probability > 0.5).map(r => r.item.id);
  // Explicit links preserve the context of terse fix PRs. One hop only, scoped on both ends.
  const seeds = new Set(selectedDocs);
  const known = new Set(scopedDocuments.map(doc => doc.id));
  const neighbors = new Map<string, Set<string>>();
  const link = (seed: string, id: string) => {
    if (!neighbors.has(seed)) neighbors.set(seed, new Set());
    neighbors.get(seed)!.add(id);
  };
  for (const doc of scopedDocuments) for (const reference of doc.references ?? []) {
    if (!known.has(reference)) continue;
    if (seeds.has(doc.id)) link(doc.id, reference);
    if (seeds.has(reference)) link(reference, doc.id);
  }
  // Keep a terse fix beside its matching issue, not after every unrelated seed.
  const orderedIds = [...new Set(selectedDocs.flatMap(id => [id, ...neighbors.get(id) ?? []]))];
  const documentTrace = judge.trace.at(-1);
  if (documentTrace?.stage === 'document_screening') documentTrace.selected = orderedIds;
  return { ids: orderedIds };
}
/** Evaluate only this page's passages; planning can be reused across requests. */
export async function retrievePlannedPage(query: string, store: RetrievalStore, judge: Judge, plan: RetrievalPlan,
  offset = 0, pageSize = 20, budget: Budgets = DEFAULT_BUDGETS, expectedRevision?: string) {
  const passages = await store.passages(plan.ids, budget.maxPassages + 1);
  if (passages.length > budget.maxPassages) throw new HttpError(422, 'passage_screening_budget_exceeded');
  const order = new Map(plan.ids.map((id, index) => [id, index]));
  // Interleave sources so a long document cannot occupy the entire first page.
  passages.sort((a, b) => a.ordinal - b.ordinal || (order.get(a.source_id) ?? 0) - (order.get(b.source_id) ?? 0));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(passages)));
  const revision = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  if (expectedRevision && revision !== expectedRevision) throw new HttpError(409, 'search_results_changed');
  const sourceTitles = new Map(passages.map(p => [p.source_id, p.title]));
  const candidates = passages.slice(offset, offset + pageSize).map(p => ({ ...p,
    description: `${p.title}\nRepository: ${p.repo}\nMetadata: ${JSON.stringify(p.metadata)}\n${p.text}\nExplicitly linked issues: ${localReferences(p.source_id, p.text).filter(id => sourceTitles.has(id)).map(id => `${id}: ${sourceTitles.get(id)}`).join("; ")}` }));
  const ranked = await judge.rankPassages(query, candidates, choiceShortlistSize);
  const evidence = ranked.map((r, i) => {
    const { description: _, ...passage } = r.item;
    return { ...passage, citation: `p${i + 1}`, relevance: r.probability };
  });
  return { evidence, hitCount: evidence.length, revision, page: Math.floor(offset / pageSize) + 1,
    totalPages: Math.ceil(passages.length / pageSize), nextOffset: offset + pageSize < passages.length ? offset + pageSize : null };
}
/** Retrieve all matching passages for legacy API clients. */
export async function retrieve(query: string, store: RetrievalStore, judge: Judge, budget: Budgets = DEFAULT_BUDGETS): Promise<RetrievalResult> {
  const plan = await planRetrieval(query, store, judge, budget);
  return retrievePlannedPage(query, store, judge, plan, 0, budget.maxPassages, budget);
}
export function gate(env: Env, decision: { supported: number; conflict: number }): 'ready' | 'insufficient_evidence' | 'conflicting_evidence' {
  const support = boundedNumber(env.SUPPORT_THRESHOLD, 0.85, 0, 1);
  const conflict = boundedNumber(env.CONFLICT_THRESHOLD, 0.7, 0, 1);
  if (decision.conflict >= conflict) return 'conflicting_evidence';
  return decision.supported >= support ? 'ready' : 'insufficient_evidence';
}


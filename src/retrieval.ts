import { branches, documentPage, passagesFor, type Branch, type SearchScope } from './store.js';
import { mapConcurrent } from './http.js';
import type { Judge } from './jev.js';
import { boundedNumber, HttpError, type Candidate, type Env, type Passage } from './types.js';
export interface RetrievalStore {
  branches(): Promise<Branch[]>;
  documentPage(branch: Branch, after: string): Promise<Candidate[]>;
  passages(ids: string[]): Promise<Passage[]>;
}
export interface Budgets { branches: number; documents: number; passages: number; maxDocuments: number; maxPassages: number }
export const DEFAULT_BUDGETS: Budgets = { branches: 6, documents: 12, passages: 10, maxDocuments: 20_000, maxPassages: 4000 };
export function d1Store(env: Env, scope?: SearchScope): RetrievalStore {
  return { branches: () => branches(env, scope), documentPage: (branch, after) => documentPage(env, branch, after),
    passages: ids => passagesFor(env, ids, scope) };
}
export interface Evidence extends Passage { citation: string; relevance: number }
export async function retrieve(query: string, store: RetrievalStore, judge: Judge, budget: Budgets = DEFAULT_BUDGETS): Promise<Evidence[]> {
  const roots = await store.branches();
  if (!roots.length) return [];
  const selected = (await judge.score(query, roots, 'branch_screening')).slice(0, budget.branches);
  let screened = 0;
  // No lexical/vector prefilter: every document title in each retained branch is evaluated.
  const pages = await mapConcurrent(selected, 4, async branch => {
    const documents: Candidate[] = [];
    let after = '';
    for (;;) {
      const page = await store.documentPage(branch.item, after);
      if (!page.length) return documents;
      screened += page.length;
      if (screened > budget.maxDocuments) throw new HttpError(422, 'document_screening_budget_exceeded');
      documents.push(...page);
      const cursor = page.at(-1)!.id;
      if (cursor <= after) throw new HttpError(503, 'invalid_document_cursor');
      after = cursor;
    }
  });
  const documentScores = await judge.score(query, pages.flat(), 'document_screening');
  const selectedDocs = documentScores.slice(0, budget.documents).map(r => r.item.id);
  const passages = await store.passages(selectedDocs);
  if (passages.length > budget.maxPassages) throw new HttpError(422, 'passage_screening_budget_exceeded');
  const candidates = passages.map(p => ({ ...p,
    description: `${p.title}\nRepository: ${p.repo}\nMetadata: ${JSON.stringify(p.metadata)}\n${p.text}` }));
  const scored = await judge.score(query, candidates, 'passage_scoring');
  // Choice compares the entire shortlist in one shared context.
  const shortlist = scored.slice(0, Math.min(20, budget.passages * 2));
  const ranked = await judge.rerank(query, shortlist);
  return ranked.slice(0, budget.passages).map((r, i) => {
    const { description: _, ...passage } = r.item;
    return { ...passage, citation: `p${i + 1}`, relevance: r.probability };
  });
}
export function gate(env: Env, decision: { supported: number; conflict: number }): 'ready' | 'insufficient_evidence' | 'conflicting_evidence' {
  const support = boundedNumber(env.SUPPORT_THRESHOLD, 0.85, 0, 1);
  const conflict = boundedNumber(env.CONFLICT_THRESHOLD, 0.7, 0, 1);
  if (decision.conflict >= conflict) return 'conflicting_evidence';
  return decision.supported >= support ? 'ready' : 'insufficient_evidence';
}

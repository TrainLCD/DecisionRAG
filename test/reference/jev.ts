// Compatibility module name. All production decisions run inside Rust/WASM.
import { decision } from './core.js';
import { HttpError, type Candidate, type Scored, type Trace } from './types.js';
export interface CitedClaim { text: string; citations: string[] }
export interface ExtractiveResult { status: string; answer: null; ticket_summaries: (CitedClaim & {source_id:string})[]; citations:string[]; verification: {method:string;complete_status:string;conflict_status:string} }
export interface Judge {
  score<T extends Candidate>(query: string, candidates: T[], stage: string): Promise<Scored<T>[]>;
  rankPassages<T extends Candidate>(query: string, candidates: T[], shortlistSize: number): Promise<Scored<T>[]>;
  assess(query: string, evidence: unknown): Promise<{ supported: number; conflict: number }>;
  verify(query: string, evidence: unknown, claims: CitedClaim[]): Promise<{ claims: number[]; complete: number; conflict: number }>;
  selectDocuments?(query: string, candidates: Candidate[], limit: number): Promise<string[]>;
  extract?(query: string, evidence: unknown): ExtractiveResult;
  engine?: string;
  exhaustive?: boolean;
  trace: Trace[];
}
export const maxCandidateChars = 24_000;
// Used only by the legacy hierarchy when a custom judge is injected in tests.
export function fitsCoarseScreeningRequest(query: string, description: string) {
  return new TextEncoder().encode(JSON.stringify({ query, description })).length <= 61_440;
}
export function probability(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
    throw new HttpError(503, 'invalid_local_score');
  return value;
}
interface RuleScore { id: string; score: number; matched: string[]; missing: string[] }
export class LocalDecision implements Judge {
  readonly engine = 'rust-rules-v1';
  readonly exhaustive = true;
  trace: Trace[] = [];
  private record(stage: string, count: number, selected: string[], start: number) {
    this.trace.push({ stage, candidates: count, selected, calls: 0, model: [this.engine],
      input_tokens: 0, output_tokens: 0, elapsed_ms: Date.now() - start });
  }
  async score<T extends Candidate>(query: string, candidates: T[], stage: string): Promise<Scored<T>[]> {
    const start = Date.now();
    const rows: Scored<T>[] = [];
    // Bound each WASM allocation. Scoring is candidate-independent, so batching
    // does not change results or introduce a corpus-size-dependent threshold.
    for (let offset = 0; offset < candidates.length; offset += 64) {
      const batch = candidates.slice(offset, offset + 64);
      const result = decision<{ scores: RuleScore[] }>({ op: 'score', query, candidates: batch });
      const byId = new Map(batch.map(item => [item.id, item]));
      for (const row of result.scores) {
        const item = byId.get(row.id);
        if (!item) throw new HttpError(503, 'invalid_local_candidate');
        rows.push({ item, probability: probability(row.score) });
      }
    }
    rows.sort((a,b) => b.probability - a.probability);
    this.record(stage, candidates.length, rows.slice(0,12).map(r => r.item.id), start);
    return rows;
  }
  async rankPassages<T extends Candidate>(query: string, candidates: T[], _shortlistSize: number) {
    return (await this.score(query, candidates, 'passage_scoring')).filter(row => row.probability > 0.5);
  }
  async selectDocuments(query: string, candidates: Candidate[], limit: number): Promise<string[]> {
    const start = Date.now();
    const ranked = await this.score(query, candidates, 'document_screening');
    // The Rust selection operation resolves one-hop links; no document bodies
    // are copied a second time. Pass the already computed scores explicitly.
    const result = decision<{ ids: string[] }>({ op: 'select_scored', candidates: candidates.map(c => ({ id:c.id,references:c.references ?? [] })),
      scores: ranked.map(r => ({id:r.item.id,score:r.probability,matched:[],missing:[]})), limit });
    this.record('document_selection', candidates.length, result.ids.slice(0,12), start);
    return result.ids;
  }
  async assess(_query: string, _evidence: unknown) {
    const start = Date.now();
    const result = decision<{supported:number;conflict:number}>({op:'assess'});
    this.record('assess_evidence',1,[],start); return result;
  }
  async verify(_query: string, evidence: unknown, claims: CitedClaim[]) {
    const start = Date.now();
    const result = decision<{claims:number[];complete:number;conflict:number}>({op:'verify',evidence,claims});
    this.record('verify_answer',claims.length,[],start); return result;
  }
  extract(query: string, evidence: unknown): ExtractiveResult {
    return decision({op:'extract',query,evidence});
  }
}

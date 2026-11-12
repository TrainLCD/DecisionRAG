//! Local deterministic decisions. Scores are rule scores, not calibrated probabilities.
mod rules;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

pub fn normalize(s: &str) -> String {
    s.nfkc().flat_map(char::to_lowercase).collect()
}
fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn contains(text: &str, term: &str) -> bool {
    text.match_indices(term).any(|(i, _)| {
        let end = i + term.len();
        (!term.starts_with(|c: char| c.is_ascii_alphanumeric())
            || !text[..i].chars().next_back().is_some_and(ascii_word))
            && (!term.ends_with(|c: char| c.is_ascii_alphanumeric())
                || !text[end..].chars().next().is_some_and(ascii_word))
    })
}
fn cjk(c: char) -> bool {
    ('\u{3400}'..='\u{9fff}').contains(&c) || ('\u{30a0}'..='\u{30ff}').contains(&c)
}
#[derive(Debug, Clone)]
struct Feature {
    name: String,
    aliases: Vec<String>,
    weight: f64,
    exact: bool,
}
fn features(query: &str) -> Vec<Feature> {
    let q = normalize(query);
    let mut residual = q.clone();
    let mut result = Vec::new();
    for &(name, weight, aliases) in rules::CONCEPTS {
        if aliases.iter().any(|a| contains(&q, a)) {
            result.push(Feature {
                name: name.into(),
                aliases: aliases.iter().map(|a| a.to_string()).collect(),
                weight,
                exact: false,
            });
            let mut sorted = aliases.to_vec();
            sorted.sort_by_key(|a| std::cmp::Reverse(a.len()));
            for alias in sorted {
                residual = residual.replace(alias, " ");
            }
        }
    }
    // Japanese particles separate concepts; remaining Kanji/Katakana runs are
    // retained, including unseen station names. ASCII identifiers stay whole.
    for stop in rules::STOP.iter().filter(|s| !s.is_ascii()) {
        residual = residual.replace(stop, " ");
    }
    let mut seen = HashSet::new();
    for token in residual.split(|c: char| {
        matches!(c, 'で' | 'は' | 'を' | 'に' | 'と' | 'の' | 'へ')
            || !(cjk(c)
                || ('\u{3040}'..='\u{309f}').contains(&c)
                || c.is_ascii_alphanumeric()
                || matches!(c, '_' | '#' | '.' | '-'))
    }) {
        let token = token.trim_matches(['.', '-', '_']);
        if token.chars().count() < 2
            || !token.chars().any(|c| cjk(c) || c.is_ascii_alphanumeric())
            || rules::STOP.contains(&token)
            || !seen.insert(token.to_string())
        {
            continue;
        }
        result.push(Feature {
            name: token.into(),
            aliases: vec![token.into()],
            weight: 1.5,
            exact: token.contains('#') || token.chars().any(|c| c.is_ascii_digit()),
        });
    }
    result
}
fn grams(s: &str) -> BTreeSet<String> {
    let cs: Vec<_> = s.chars().collect();
    cs.windows(2).map(|c| c.iter().collect()).collect()
}
fn matching(f: &Feature, text: &str) -> f64 {
    if f.aliases.iter().any(|a| contains(text, a)) {
        return 1.0;
    }
    // Domain-specific indirect evidence is weaker than an explicit topic.
    if f.name == "location" && ["到着判定", "接近到着"].iter().any(|t| text.contains(t)) {
        return 0.65;
    }
    if !f.exact && f.aliases.len() == 1 && f.name.chars().all(cjk) && f.name.chars().count() >= 4 {
        let gs = grams(&f.name);
        let coverage =
            gs.iter().filter(|g| text.contains(g.as_str())).count() as f64 / gs.len() as f64;
        if coverage >= 0.75 {
            return coverage * 0.8;
        }
    }
    0.0
}
#[derive(Deserialize, Clone)]
struct Candidate {
    id: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    references: Vec<String>,
}
#[derive(Deserialize, Serialize, Clone, Debug)]
struct Score {
    id: String,
    score: f64,
    matched: Vec<String>,
    missing: Vec<String>,
}
fn score(fs: &[Feature], c: &Candidate) -> Score {
    let text = normalize(&c.description);
    let title = text.lines().next().unwrap_or("");
    let total: f64 = fs.iter().map(|f| f.weight).sum();
    let mut hit = 0.0;
    let mut title_hit = 0.0;
    let mut matched = Vec::new();
    let mut missing = Vec::new();
    let mut missing_exact = false;
    for f in fs {
        let m = matching(f, &text);
        hit += f.weight * m;
        title_hit += f.weight * matching(f, title);
        if m > 0.0 {
            matched.push(f.name.clone());
        } else {
            missing.push(f.name.clone());
            missing_exact |= f.exact;
        }
    }
    let mut value = if total > 0.0 && hit > 0.0 {
        0.15 + 0.77 * hit / total + 0.08 * title_hit / total
    } else {
        0.0
    };
    if missing_exact {
        value = value.min(0.49);
    }
    Score {
        id: c.id.clone(),
        score: value.min(1.0),
        matched,
        missing,
    }
}
fn scores(query: &str, candidates: &[Candidate]) -> Vec<Score> {
    let fs = features(query);
    let mut out: Vec<_> = candidates.iter().map(|c| score(&fs, c)).collect();
    // Stable order is part of the pagination contract.
    out.sort_by(|a, b| b.score.total_cmp(&a.score));
    out
}
#[derive(Deserialize, Clone)]
struct Evidence {
    citation: String,
    #[serde(default)]
    source_id: String,
    #[serde(default)]
    text: String,
}
#[derive(Deserialize)]
struct Claim {
    text: String,
    citations: Vec<String>,
}
fn sentences(text: &str) -> impl Iterator<Item = &str> {
    text.split_inclusive(['。', '！', '？', '\n'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
}
fn exact_claim(claim: &str, evidence: &Evidence) -> bool {
    // Exact whole spans only. Removing a negation or a conditional prefix must
    // not turn source text into a verified assertion. No fuzzy entailment.
    let trim = |s: &str| s.trim().trim_end_matches(['。', '.']).to_string();
    let c = trim(claim);
    c.chars().count() >= 8 && sentences(&evidence.text).any(|s| trim(s) == c)
}
fn unknown_assessment() -> Value {
    json!({"supported":0.0,"conflict":0.0,"support_status":"unknown","conflict_status":"unknown","method":"exact_source_span"})
}
fn verify(evidence: &[Evidence], claims: &[Claim]) -> Value {
    let by_id: HashMap<_, _> = evidence.iter().map(|e| (e.citation.as_str(), e)).collect();
    let mut reasons = Vec::new();
    let values: Vec<f64> = claims
        .iter()
        .map(|c| {
            if c.citations.is_empty()
                || c.citations
                    .iter()
                    .any(|id| !by_id.contains_key(id.as_str()))
            {
                reasons.push("invalid_citation");
                return 0.0;
            }
            // An exact quotation establishes attribution only, not truth, causal
            // inference, release status or completeness. Report this separately.
            let supported = c
                .citations
                .iter()
                .any(|id| exact_claim(&c.text, by_id[id.as_str()]));
            reasons.push(if supported {
                "exact_source_span"
            } else {
                "paraphrase_not_proven"
            });
            if supported { 1.0 } else { 0.0 }
        })
        .collect();
    json!({"claims":values,"complete":0.0,"conflict":0.0,"conflict_status":"unknown","complete_status":"unknown","method":"source_attribution_only","reasons":reasons})
}
fn extracts(query: &str, evidence: &[Evidence]) -> Value {
    let fs = features(query);
    let mut seen = HashSet::new();
    let mut summaries = Vec::new();
    for e in evidence {
        if !seen.insert(&e.source_id) {
            continue;
        }
        let mut spans: Vec<_> = sentences(&e.text)
            .filter(|s| s.chars().count() >= 8 && s.chars().count() <= 400)
            .collect();
        spans.sort_by(|a, b| {
            let rank = |s: &str| {
                score(
                    &fs,
                    &Candidate {
                        id: String::new(),
                        description: s.into(),
                        references: vec![],
                    },
                )
                .score
            };
            rank(b).total_cmp(&rank(a))
        });
        if let Some(span) = spans.first() {
            summaries.push(json!({"source_id":e.source_id,"text":format!("資料の記載：『{}』", span),"citations":[e.citation],"method":"extractive"}));
        }
    }
    json!({"status":if summaries.is_empty(){"insufficient_evidence"}else{"summarized"},"answer":null,"ticket_summaries":summaries,
        "citations":summaries.iter().flat_map(|s| s["citations"].as_array().unwrap().iter().cloned()).collect::<Vec<_>>(),
        "verification":{"method":"source_attribution_only","complete_status":"unknown","conflict_status":"unknown"}})
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    Score {
        query: String,
        candidates: Vec<Candidate>,
    },
    Select {
        query: String,
        candidates: Vec<Candidate>,
        limit: usize,
    },
    SelectScored {
        candidates: Vec<Candidate>,
        scores: Vec<Score>,
        limit: usize,
    },
    Verify {
        evidence: Vec<Evidence>,
        claims: Vec<Claim>,
    },
    Assess {},
    Extract {
        query: String,
        evidence: Vec<Evidence>,
    },
}
pub fn process(input: &[u8]) -> Vec<u8> {
    let output = if input.len() > 16 * 1024 * 1024 {
        json!({"error":"decision_input_too_large"})
    } else {
        match serde_json::from_slice::<Request>(input) {
            Err(_) => json!({"error":"invalid_decision_input"}),
            Ok(Request::Score { query, candidates }) => {
                json!({"scores":scores(&query,&candidates),"engine":rules::VERSION})
            }
            Ok(Request::Select {
                query,
                candidates,
                limit,
            }) => select(&candidates, scores(&query, &candidates), limit),
            Ok(Request::SelectScored {
                candidates,
                scores,
                limit,
            }) => select(&candidates, scores, limit),
            Ok(Request::Verify { evidence, claims }) => verify(&evidence, &claims),
            Ok(Request::Assess {}) => unknown_assessment(),
            Ok(Request::Extract { query, evidence }) => extracts(&query, &evidence),
        }
    };
    serde_json::to_vec(&output).expect("serializable decisions")
}
fn select(candidates: &[Candidate], scored: Vec<Score>, limit: usize) -> Value {
    let seeds: Vec<_> = scored
        .iter()
        .enumerate()
        .filter(|(i, s)| *i < limit || s.score > 0.5)
        .map(|(_, s)| s.id.clone())
        .collect();
    let known: HashSet<_> = candidates.iter().map(|c| c.id.as_str()).collect();
    let mut neighbors: HashMap<&str, Vec<&str>> = HashMap::new();
    for c in candidates {
        for r in &c.references {
            if known.contains(r.as_str()) {
                neighbors.entry(&c.id).or_default().push(r);
                neighbors.entry(r).or_default().push(&c.id);
            }
        }
    }
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for seed in seeds {
        for id in std::iter::once(seed.as_str())
            .chain(neighbors.get(seed.as_str()).into_iter().flatten().copied())
        {
            if seen.insert(id.to_string()) {
                ids.push(id.to_string());
            }
        }
    }
    json!({"ids":ids,"scores":scored,"engine":rules::VERSION})
}

// Minimal synchronous JSON ABI, shared by Workers and the Node test harness.
// The host allocates each input once, calls evaluate once (consumes the input),
// copies the output, and frees it exactly once. No host functions or network imports.
#[cfg(target_arch = "wasm32")]
mod wasm {
    #[unsafe(no_mangle)]
    pub extern "C" fn allocate(len: usize) -> *mut u8 {
        if len > 16 * 1024 * 1024 {
            return std::ptr::null_mut();
        }
        Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn evaluate(ptr: *mut u8, len: usize) -> u64 {
        let input = unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) };
        let output = super::process(&input).into_boxed_slice();
        let length = output.len() as u64;
        let pointer = Box::into_raw(output) as *mut u8 as u64;
        (length << 32) | pointer
    }
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn release(ptr: *mut u8, len: usize) {
        drop(unsafe { Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len)) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(value: Value) -> Value {
        serde_json::from_slice(&process(&serde_json::to_vec(&value).unwrap())).unwrap()
    }
    fn candidate(id: &str, text: &str) -> Value {
        json!({"id":id,"description":text})
    }
    #[test]
    fn bilingual_topics_beat_incidental_words() {
        let out = run(
            json!({"op":"score","query":"地下鉄で位置更新が止まる問題","candidates":[
            candidate("location","Restore location updates in underground tunnels using heartbeat."),
            candidate("name","地下鉄の駅名の翻訳を更新"),candidate("bus","バスの乗り場名を表示")]}),
        );
        assert_eq!(out["scores"][0]["id"], "location");
        assert!(out["scores"][0]["score"].as_f64().unwrap() > 0.5);
        assert!(out["scores"][1]["score"].as_f64().unwrap() <= 0.5);
    }
    #[test]
    fn identifiers_and_word_boundaries_are_not_substrings() {
        for (query, text) in [
            ("315系テーマ", "1315系テーマ"),
            ("315系テーマ", "3150系テーマ"),
            ("#7403", "#74030"),
            ("GPS", "mygpshelper"),
        ] {
            let out = run(json!({"op":"score","query":query,"candidates":[candidate("x",text)]}));
            assert!(
                out["scores"][0]["score"].as_f64().unwrap() <= 0.5,
                "{query}: {text}"
            );
        }
    }
    #[test]
    fn unicode_normalization_and_novel_entities() {
        for (query, text) in [
            ("ＧＰＳ バックグラウンド", "background gps updates"),
            ("光が丘", "光が丘の座標を修正"),
            ("315系テーマ", "315系のテーマを追加"),
        ] {
            let out = run(json!({"op":"score","query":query,"candidates":[candidate("x",text)]}));
            assert!(out["scores"][0]["score"].as_f64().unwrap() > 0.5, "{query}");
        }
    }
    #[test]
    fn ties_and_scoped_one_hop_links_are_stable() {
        let out = run(json!({"op":"select","query":"GPS","limit":1,"candidates":[
            {"id":"a","description":"GPS","references":["b","private"]},
            {"id":"b","description":"Fix #1","references":["c"]},
            {"id":"c","description":"unrelated"}]}));
        assert_eq!(out["ids"], json!(["a", "b"]));
        let out = run(
            json!({"op":"score","query":"GPS","candidates":[candidate("z","GPS"),candidate("a","GPS")]}),
        );
        assert_eq!(out["scores"][0]["id"], "z");
    }
    #[test]
    fn verification_rejects_negation_causality_release_and_missing_citations() {
        let out = run(
            json!({"op":"verify","evidence":[{"citation":"p1","text":"バックグラウンドでは位置を更新しない。\nこの変更は提案中です。\n条件を満たす場合、バスを表示する。"}],"claims":[
            {"text":"バックグラウンドでは位置を更新する。","citations":["p1"]},
            {"text":"位置情報が原因でクラッシュした。","citations":["p1"]},
            {"text":"App Storeで配信済みです。","citations":["p1"]},
            {"text":"バックグラウンドでは位置を更新しない。","citations":["missing"]},
            {"text":"バスを表示する。","citations":["p1"]},
            {"text":"バックグラウンドでは位置を更新しない。","citations":["p1"]}]}),
        );
        assert_eq!(out["claims"], json!([0.0, 0.0, 0.0, 0.0, 0.0, 1.0]));
        assert_eq!(out["complete_status"], "unknown");
        assert_eq!(out["conflict_status"], "unknown");
    }
    #[test]
    fn extraction_attributes_unmodified_text_and_deduplicates_sources() {
        let out = run(json!({"op":"extract","query":"GPS","evidence":[
            {"citation":"p1","source_id":"one","text":"GPSの位置更新を修正した。\nその他の変更です。"},
            {"citation":"p2","source_id":"one","text":"これは別の本文区間です。"}]}));
        assert_eq!(out["status"], "summarized");
        assert!(out["answer"].is_null());
        assert_eq!(out["ticket_summaries"].as_array().unwrap().len(), 1);
        assert_eq!(
            out["ticket_summaries"][0]["text"],
            "資料の記載：『GPSの位置更新を修正した。』"
        );
    }
    #[test]
    fn uninformative_query_does_not_match_everything() {
        let out = run(
            json!({"op":"score","query":"教えてください","candidates":[candidate("x","GPS location")]}),
        );
        assert_eq!(out["scores"][0]["score"], 0.0);
        assert_eq!(
            run(json!({"op":"unsupported"}))["error"],
            "invalid_decision_input"
        );
    }
}

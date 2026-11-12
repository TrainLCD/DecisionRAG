//! Local deterministic decisions. Scores are rule scores, not calibrated probabilities.
mod rules;
mod verification;
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
fn word_boundary(text: &str, term: &str, i: usize) -> bool {
    let end = i + term.len();
    (!term.starts_with(|c: char| c.is_ascii_alphanumeric())
        || !text[..i].chars().next_back().is_some_and(ascii_word))
        && (!term.ends_with(|c: char| c.is_ascii_alphanumeric())
            || !text[end..].chars().next().is_some_and(ascii_word))
}
fn contains(text: &str, term: &str) -> bool {
    text.match_indices(term)
        .any(|(i, _)| word_boundary(text, term, i))
}
fn remove_alias(text: &str, term: &str) -> String {
    let mut out = String::new();
    let mut from = 0;
    for (i, _) in text
        .match_indices(term)
        .filter(|(i, _)| word_boundary(text, term, *i))
    {
        out.push_str(&text[from..i]);
        out.push(' ');
        from = i + term.len();
    }
    out.push_str(&text[from..]);
    out
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
        if aliases.iter().any(|a| contains(&q, a))
            || (name == "location" && q.split_whitespace().any(|word| word == "location"))
        {
            result.push(Feature {
                name: name.into(),
                aliases: aliases.iter().map(|a| a.to_string()).collect(),
                weight,
                exact: false,
            });
            if name == "location" && q.split_whitespace().any(|word| word == "location") {
                residual = remove_alias(&residual, "location");
            }
            let mut sorted = aliases.to_vec();
            sorted.sort_by_key(|a| std::cmp::Reverse(a.len()));
            for alias in sorted {
                residual = remove_alias(&residual, alias);
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
fn score(fs: &[Feature], c: &Candidate, allow_partial: bool) -> Score {
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
    // A multi-topic question needs evidence for more than one feature. A lone
    // GPS mention in an unrelated review must not pass on weight alone.
    if missing_exact || (!allow_partial && fs.len() > 1 && matched.len() < 2) {
        value = value.min(0.49);
    }
    Score {
        id: c.id.clone(),
        score: value.min(1.0),
        matched,
        missing,
    }
}
fn scores(query: &str, candidates: &[Candidate], allow_partial: bool) -> Vec<Score> {
    let fs = features(query);
    let mut out: Vec<_> = candidates
        .iter()
        .map(|c| score(&fs, c, allow_partial))
        .collect();
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
    #[serde(default)]
    title: String,
}
#[derive(Deserialize)]
struct Claim {
    text: String,
    citations: Vec<String>,
}
fn sentences(text: &str) -> impl Iterator<Item = &str> {
    let mut spans = Vec::new();
    let mut from = 0;
    for (i, c) in text.char_indices() {
        let end = i + c.len_utf8();
        let english = matches!(c, '.' | '!' | '?')
            && text[end..].chars().next().is_none_or(char::is_whitespace);
        let abbreviation = if c == '.' && english {
            let token = text[..i]
                .split_whitespace()
                .next_back()
                .unwrap_or("")
                .to_lowercase();
            [
                "e.g", "i.e", "etc", "mr", "mrs", "ms", "dr", "prof", "vs", "no",
            ]
            .contains(&token.as_str())
                || (token.len() == 1 && token.bytes().all(|b| b.is_ascii_alphabetic()))
        } else {
            false
        };
        if matches!(c, '。' | '！' | '？' | '\n') || (english && !abbreviation) {
            spans.push(&text[from..end]);
            from = end;
        }
    }
    if from < text.len() {
        spans.push(&text[from..]);
    }
    spans.into_iter().map(str::trim).filter(|s| !s.is_empty())
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
            let exact = c
                .citations
                .iter()
                .any(|id| exact_claim(&c.text, by_id[id.as_str()]));
            let sources: Vec<_> = c
                .citations
                .iter()
                .flat_map(|id| {
                    let e = by_id[id.as_str()];
                    sentences(&e.text).chain(std::iter::once(e.title.as_str()))
                })
                .collect();
            let numeric_conflict = !exact && verification::numeric_conflict(&c.text, &sources);
            let paraphrase = !exact
                && !numeric_conflict
                && sources
                    .iter()
                    .any(|source| verification::supports(&c.text, source));
            let context = sources.join("\n");
            let related = verification::overlap(&c.text, &context) >= 0.35;
            let nearest = sources.iter().max_by(|a, b| {
                verification::overlap(&c.text, a).total_cmp(&verification::overlap(&c.text, b))
            });
            let contradicted = !exact
                && related
                && (numeric_conflict
                    || (!paraphrase
                        && (nearest
                            .is_some_and(|source| verification::contradicts(&c.text, source))
                            || !verification::facts_compatible(
                                &normalize(&c.text),
                                &normalize(&context),
                            ))));
            reasons.push(if exact {
                "exact_source_span"
            } else if paraphrase {
                "local_paraphrase_rules"
            } else if contradicted {
                "local_rule_conflict"
            } else if related {
                "semantic_support_unknown"
            } else {
                "insufficient_local_support"
            });
            if exact {
                1.0
            } else if paraphrase {
                0.9
            } else {
                0.0
            }
        })
        .collect();
    json!({"claims":values,"complete":0.0,"conflict":0.0,"conflict_status":"unknown","complete_status":"unknown","method":"local_support_rules","semantic_status":"unknown","reasons":reasons})
}
fn extracts(query: &str, evidence: &[Evidence]) -> Value {
    let fs = features(query);
    let mut seen = HashSet::new();
    let mut summaries = Vec::new();
    for e in evidence {
        if seen.contains(&e.source_id) {
            continue;
        }
        let mut spans: Vec<_> = sentences(&e.text)
            .filter(|s| s.chars().count() >= 8 && s.chars().count() <= 400)
            .collect();
        let rank = |s: &str| {
            score(
                &fs,
                &Candidate {
                    id: String::new(),
                    description: s.into(),
                    references: vec![],
                },
                true,
            )
            .score
        };
        spans.retain(|span| rank(span) > 0.0);
        spans.sort_by(|a, b| rank(b).total_cmp(&rank(a)));
        if let Some(span) = spans.first() {
            seen.insert(&e.source_id);
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
        #[serde(default)]
        allow_partial: bool,
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
            Ok(Request::Score {
                query,
                candidates,
                allow_partial,
            }) => {
                json!({"scores":scores(&query,&candidates,allow_partial),"engine":rules::VERSION})
            }
            Ok(Request::Select {
                query,
                candidates,
                limit,
            }) => select(&candidates, scores(&query, &candidates, false), limit),
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
    fn verification_rejects_swapped_negations_and_borrowed_actions() {
        for (claim, source) in [
            (
                "GPSは更新するが、バスは表示しない。",
                "GPSは更新しないが、バスは表示する。",
            ),
            (
                "バスの乗換案内を追加した。",
                "バスの乗換案内を削除し、GPSの更新機能を追加した。",
            ),
        ] {
            let input = json!({"op":"verify","evidence":[{"citation":"p1","text":source}],"claims":[{"text":claim,"citations":["p1"]}]});
            let output: Value =
                serde_json::from_slice(&process(input.to_string().as_bytes())).unwrap();
            assert_eq!(output["claims"], json!([0.0]), "{claim}");
        }
    }
    #[test]
    fn extraction_skips_unrelated_spans_without_hiding_later_evidence() {
        let input = json!({"op":"extract","query":"GPS","evidence":[
            {"citation":"p1","source_id":"one","title":"GPS","text":"バスの乗換案内を追加しました。"}
        ]});
        let output: Value = serde_json::from_slice(&process(input.to_string().as_bytes())).unwrap();
        assert_eq!(output["status"], "insufficient_evidence");
        assert_eq!(output["ticket_summaries"], json!([]));
        let mut input = input;
        input["evidence"].as_array_mut().unwrap().push(json!({"citation":"p2","source_id":"one","title":"GPS","text":"GPSの更新が停止しました。"}));
        let output: Value = serde_json::from_slice(&process(input.to_string().as_bytes())).unwrap();
        assert_eq!(output["ticket_summaries"][0]["citations"], json!(["p2"]));
    }
    #[test]
    fn verification_keeps_numbers_with_their_subject_and_rejects_past_negation() {
        let out = run(json!({"op":"verify","evidence":[
            {"citation":"p1","text":"Zephyr checksum uses version 41."},
            {"citation":"p2","text":"Orchid cache uses version 42."},
            {"citation":"p3","text":"バスの乗換案内を追加しなかった。"}
        ],"claims":[
            {"text":"Zephyr checksum uses version 42.","citations":["p1","p2"]},
            {"text":"Zephyr checksum uses version 41 and Orchid cache uses version 42.","citations":["p1","p2"]},
            {"text":"バスの乗換案内を追加した。","citations":["p3"]}
        ]}));
        assert_eq!(out["reasons"][0], "local_rule_conflict");
        assert_eq!(out["reasons"][1], "semantic_support_unknown");
        assert_eq!(out["reasons"][2], "local_rule_conflict");
    }
    #[test]
    fn verification_binds_numbers_to_subjects_within_one_citation() {
        let out = run(json!({"op":"verify","evidence":[
            {"citation":"p1","text":"Zephyr checksum uses version 41 and Orchid cache uses version 42."}
        ],"claims":[
            {"text":"Zephyr checksum uses version 42.","citations":["p1"]},
            {"text":"Orchid cache uses version 41.","citations":["p1"]},
            {"text":"Zephyr checksum uses version 41.","citations":["p1"]},
            {"text":"Orchid cache uses version 42 and Zephyr checksum uses version 41.","citations":["p1"]}
        ]}));
        assert_eq!(out["reasons"][0], "local_rule_conflict");
        assert_eq!(out["reasons"][1], "local_rule_conflict");
        for i in [2, 3] {
            assert_ne!(out["reasons"][i], "local_rule_conflict");
        }
    }
    #[test]
    fn verification_preserves_numeric_lists_for_one_subject() {
        let out = run(json!({"op":"verify","evidence":[
            {"citation":"p1","text":"Zephyr supports TLS 1.2 and 1.3."}
        ],"claims":[
            {"text":"Zephyr supports TLS 1.3.","citations":["p1"]},
            {"text":"Zephyr supports TLS 1.4.","citations":["p1"]}
        ]}));
        assert_ne!(out["reasons"][0], "local_rule_conflict");
        assert_eq!(out["reasons"][1], "local_rule_conflict");
    }
    #[test]
    fn gtfs_multi_paragraph_answer_is_not_rejected_as_a_contradiction() {
        let captured: Value =
            serde_json::from_str(include_str!("../test/fixtures/gtfs-answer-regression.json"))
                .unwrap();
        let claims: Vec<_> = captured["draft"]["answer"]
            .as_array()
            .unwrap()
            .iter()
            .map(|text| json!({"text":text,"citations":["p1","p2","p3"]}))
            .collect();
        let result = run(json!({"op":"verify","evidence":captured["evidence"],"claims":claims}));
        assert_eq!(
            result["reasons"],
            json!([
                "semantic_support_unknown",
                "semantic_support_unknown",
                "semantic_support_unknown"
            ])
        );
        assert_eq!(result["semantic_status"], "unknown");
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
    fn document_prefilter_can_keep_partial_matches_without_relaxing_passages() {
        for partial in [false, true] {
            let out = run(
                json!({"op":"score","query":"地下鉄で位置更新が止まる問題","allow_partial":partial,"candidates":[candidate("doc","GPS location updates")] }),
            );
            assert_eq!(out["scores"][0]["score"].as_f64().unwrap() > 0.5, partial);
            let exact = run(
                json!({"op":"score","query":"GPS #7403","allow_partial":partial,"candidates":[candidate("wrong","GPS #74030")] }),
            );
            assert!(exact["scores"][0]["score"].as_f64().unwrap() <= 0.5);
        }
    }
    #[test]
    fn aliases_preserve_identifiers_and_english_sentences() {
        let out = run(
            json!({"op":"score","query":"GPS useGPSProvider","candidates":[candidate("exact","GPS useGPSProvider")]}),
        );
        assert!(out["scores"][0]["score"].as_f64().unwrap() > 0.9);
        assert_eq!(
            sentences(
                "Use Location.Accuracy and version 1.2. Dr. Smith checks GPS. Updates continue!"
            )
            .collect::<Vec<_>>(),
            vec![
                "Use Location.Accuracy and version 1.2.",
                "Dr. Smith checks GPS.",
                "Updates continue!"
            ]
        );
        let long = "GPS location updates continue in background. ".repeat(15);
        let out = run(
            json!({"op":"extract","query":"GPS","evidence":[{"citation":"p1","source_id":"a","text":"GPS"},{"citation":"p2","source_id":"a","text":long}]}),
        );
        assert_eq!(out["ticket_summaries"][0]["citations"], json!(["p2"]));
        assert_eq!(out["ticket_summaries"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn location_is_not_layout_or_url_syntax() {
        let out = run(
            json!({"op":"score","query":"地下鉄で位置更新が止まる問題","candidates":[
            candidate("layout", "ボタンの位置を修正。画面の表示位置を調整する。"),
            candidate("url", "Use window.location to update the URL. <location>https://example.test</location>"),
            candidate("source", "Location: src/components/Layout.tsx"),
            candidate("incidental", "GraphQL schema review: a GPS field uses nullable numeric values."),
            candidate("gps", "Background location updates stop in underground tunnels.")]}),
        );
        for row in out["scores"].as_array().unwrap() {
            assert_eq!(row["score"].as_f64().unwrap() > 0.5, row["id"] == "gps");
        }
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

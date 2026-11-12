//! Conservative lexical checks for generated paraphrases, not semantic proof.
use super::{contains, normalize, remove_alias, rules};
use std::collections::BTreeSet;

fn has(text: &str, terms: &[&str]) -> bool {
    terms.iter().any(|term| contains(text, term))
}
fn units(text: &str) -> BTreeSet<String> {
    let mut residual = text.to_owned();
    let mut result = BTreeSet::new();
    for &(name, _, aliases) in rules::CONCEPTS {
        if aliases.iter().any(|alias| contains(text, alias)) {
            result.insert(format!("topic:{name}"));
            let mut aliases = aliases.to_vec();
            aliases.sort_by_key(|alias| std::cmp::Reverse(alias.len()));
            for alias in aliases {
                residual = remove_alias(&residual, alias);
            }
        }
    }
    for run in residual.split(|c: char| !super::cjk(c) && !c.is_ascii_alphanumeric() && c != '_') {
        if run.is_empty() {
            continue;
        }
        if run.is_ascii() {
            if run.len() > 1
                && ![
                    "the", "a", "an", "is", "are", "was", "were", "in", "on", "of", "to", "for",
                    "and", "with", "it", "this", "that",
                ]
                .contains(&run)
            {
                result.insert(run.into());
            }
        } else {
            let chars: Vec<_> = run.chars().collect();
            if chars.len() == 1 {
                result.insert(run.into());
            } else {
                result.extend(chars.windows(2).map(|pair| pair.iter().collect::<String>()));
            }
        }
    }
    result
}

fn qualifiers_compatible(claim: &str, source: &str) -> bool {
    let claim = normalize(claim);
    let source = normalize(source);
    // Preserve negation, conditions and uncertainty even when most nouns agree.
    for group in [
        &[
            "ない",
            "なかった",
            "せず",
            "ません",
            "未対応",
            "未実装",
            "未修正",
            "未解決",
            "not",
            "never",
            "without",
            "cannot",
            "can't",
            "doesn't",
            "don't",
            "isn't",
            "didn't",
            "wasn't",
            "weren't",
            "couldn't",
        ][..],
        &[
            "場合",
            "とき",
            "時のみ",
            "条件",
            "if",
            "unless",
            "only when",
        ][..],
        &[
            "予定",
            "提案",
            "検討",
            "可能性",
            "かもしれ",
            "未確認",
            "不明",
            "疑い",
            "plan",
            "proposed",
            "may",
            "might",
            "could",
            "unknown",
        ][..],
    ] {
        if has(&claim, group) != has(&source, group) {
            return false;
        }
    }
    true
}

fn compatible(claim: &str, source: &str) -> bool {
    qualifiers_compatible(claim, source) && facts_compatible(&normalize(claim), &normalize(source))
}

pub(super) fn facts_compatible(claim: &str, source: &str) -> bool {
    // Topic similarity alone must not invent causes, releases or completed work.
    for group in [
        &["原因", "ため", "によって", "because", "caused", "due to"][..],
        &[
            "配信",
            "app store",
            "google play",
            "デプロイ",
            "deployed",
            "distributed",
        ][..],
        &["リリース", "release", "released"][..],
        &["マージ", "merge", "merged"][..],
        &["修正", "解消", "解決", "fixed", "fix", "resolved"][..],
        &["追加", "導入", "実装", "added", "add", "implemented"][..],
        &["削除", "廃止", "除去", "removed", "remove", "deleted"][..],
    ] {
        if has(claim, group) && !has(source, group) {
            return false;
        }
    }
    // Version numbers and identifiers cannot be supplied by topic overlap.
    for token in
        claim.split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '_' | '-' | '#'))
    {
        let token = token.trim_matches(['.', '-', '_']);
        if token.chars().any(|c| c.is_ascii_digit()) && !contains(source, token) {
            return false;
        }
    }
    true
}

pub(super) fn overlap(claim: &str, source: &str) -> f64 {
    let claim_units = units(&normalize(claim));
    let source_units = units(&normalize(source));
    let shared = claim_units.intersection(&source_units).count();
    if shared < 2 {
        return 0.0;
    }
    shared as f64 / claim_units.len().max(1) as f64
}

pub(super) fn supports(claim: &str, source: &str) -> bool {
    overlap(claim, source) >= 0.75 && compatible(claim, source)
}

pub(super) fn contradicts(claim: &str, source: &str) -> bool {
    // Missing facts in a single sentence are not contradictions: the answer
    // may summarize several cited paragraphs. Check factual omissions against
    // the entire cited context in verify(), not independently per sentence.
    overlap(claim, source) >= 0.75 && !qualifiers_compatible(claim, source)
}

fn numeric_tokens(text: &str) -> Vec<&str> {
    text.split(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, '.' | '_' | '-' | '#'))
        .map(|s| s.trim_matches(['.', '-', '_']))
        .filter(|s| s.chars().any(|c| c.is_ascii_digit()))
        .collect()
}

fn numeric_clauses(text: &str) -> impl Iterator<Item = &str> {
    text.split(['、', ',', ';', '。', '\n'])
        .flat_map(|s| s.split(" and "))
}

/// Bind each numeric assertion to the closest subject-bearing source, instead
/// of borrowing a matching number from an unrelated citation. Separate clauses
/// can still summarize different sources and different numbers.
pub(super) fn numeric_conflict(claim: &str, sources: &[&str]) -> bool {
    let claim = normalize(claim);
    let sources: Vec<_> = sources.iter().map(|s| normalize(s)).collect();
    let sources: Vec<_> = sources.iter().flat_map(|s| numeric_clauses(s)).collect();
    for clause in numeric_clauses(&claim) {
        let numbers = numeric_tokens(clause);
        if numbers.is_empty() {
            continue;
        }
        let subject: BTreeSet<_> = units(clause)
            .into_iter()
            .filter(|s| !s.chars().any(|c| c.is_ascii_digit()))
            .collect();
        if subject.is_empty() {
            continue;
        }
        let scores: Vec<_> = sources
            .iter()
            .map(|source| subject.intersection(&units(source)).count())
            .collect();
        let best = scores.iter().copied().max().unwrap_or(0);
        if best as f64 / (subject.len() as f64) < 0.75 {
            continue;
        }
        for number in numbers {
            if !sources
                .iter()
                .zip(&scores)
                .any(|(source, score)| *score == best && contains(source, number))
            {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_supported_rewording_without_exact_copy() {
        for (claim, source) in [
            (
                "地下鉄で位置情報の更新が停止する問題があります。",
                "地下鉄でGPSの更新が止まる問題を確認した。",
            ),
            (
                "GPS位置情報の更新を修正しています。",
                "GPS位置情報を更新する処理を修正した。",
            ),
            (
                "バスの乗換案内を追加しています。",
                "バスで乗り換えの案内を追加した。",
            ),
        ] {
            assert!(
                supports(claim, source),
                "{claim}: {:?} {:?}",
                units(&normalize(claim)),
                units(&normalize(source))
            );
        }
    }
    #[test]
    fn rejects_shared_topics_with_changed_facts() {
        for (claim, source) in [
            ("地下鉄でGPSが更新する。", "地下鉄でGPSが更新しない。"),
            ("GPSの更新を修正した。", "GPSの更新を修正する予定です。"),
            (
                "バスの乗換案内を表示する。",
                "条件を満たす場合、バスの乗換案内を表示する。",
            ),
            ("GPSが原因で地下鉄で停止する。", "GPSは地下鉄で停止する。"),
            (
                "GPSの修正はApp Storeで配信済み。",
                "GPSの修正PRをマージした。",
            ),
            (
                "GPSの更新をv10.2で修正した。",
                "GPSの更新をv10.1で修正した。",
            ),
            ("バスの乗換案内を追加した。", "バスの乗換案内を削除した。"),
            (
                "GPSを使ってバスの運賃を計算する。",
                "GPSを使ってバスの乗換案内を表示する。",
            ),
        ] {
            assert!(!supports(claim, source), "{claim}");
        }
    }
}

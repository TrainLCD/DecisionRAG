//! Reviewed structured snapshots only. Search hits and model prose are never inputs.
use crate::{judge::Judge, runtime::*, storage::Scope};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub unit: String,
    pub scope: String,
    pub as_of: String,
    pub valid_until: String,
    pub identity_namespace: String,
    pub revision: String,
    pub source_refs: Vec<String>,
    pub repositories: Vec<String>,
    pub completeness_basis: String,
    pub complete: bool,
    pub expected_count: usize,
    pub error_count: usize,
    pub members: Vec<String>,
    pub support_definition: String,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Metric {
    pub id: String,
    pub definition: String,
    pub unit: String,
    pub scope: String,
    pub support_definition: String,
    pub population: Option<Snapshot>,
    pub supported: Option<Snapshot>,
}
fn timestamp(s: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()
}
fn complete(snapshot: &Snapshot, now: time::OffsetDateTime) -> bool {
    !snapshot.repositories.is_empty()
        && snapshot.complete
        && !snapshot.completeness_basis.trim().is_empty()
        && !snapshot.revision.trim().is_empty()
        && !snapshot.identity_namespace.trim().is_empty()
        && !snapshot.source_refs.is_empty()
        && snapshot.source_refs.iter().all(|s| {
            url::Url::parse(s).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some())
        })
        && snapshot.expected_count == snapshot.members.len()
        && snapshot.error_count == 0
        && snapshot
            .members
            .iter()
            .all(|s| !s.trim().is_empty() && s.trim() == s)
        && timestamp(&snapshot.as_of).is_some_and(|t| t <= now)
        && timestamp(&snapshot.valid_until).is_some_and(|t| t >= now)
}
fn base(metric: &Metric) -> Value {
    json!({"status":"missing_population","metric_id":metric.id,"definition":metric.definition,
        "unit":metric.unit,"scope":metric.scope,"support_definition":metric.support_definition,
        "numerator":null,"denominator":null,"value":null,"as_of":null,
        "source_refs":[],"missing_requirements":[],"rounding":"nearest_0.01_percent_half_up"})
}
/// Inputs come from a reviewed deployment asset, never request JSON or retrieved text.
/// Reject inconsistent snapshots; do not silently count only their intersection.
pub fn calculate(metric: &Metric, now: time::OffsetDateTime) -> Value {
    let mut out = base(metric);
    let mut missing = Vec::new();
    if metric.population.as_ref().is_none_or(|s| !complete(s, now)) {
        missing.push("complete_current_population_with_provenance");
    }
    if metric.supported.as_ref().is_none_or(|s| !complete(s, now)) {
        missing.push("complete_current_production_set_with_provenance");
    }
    if !missing.is_empty() {
        out["status"] = json!(if missing[0].starts_with("complete_current_population") {
            "missing_population"
        } else {
            "missing_supported_set"
        });
        out["missing_requirements"] = json!(missing);
        return out;
    }
    let p = metric.population.as_ref().unwrap();
    let s = metric.supported.as_ref().unwrap();
    if p.unit != metric.unit
        || s.unit != metric.unit
        || p.scope != metric.scope
        || s.scope != metric.scope
        || timestamp(&p.as_of) != timestamp(&s.as_of)
        || p.identity_namespace != s.identity_namespace
        || s.support_definition != metric.support_definition
    {
        out["status"] = json!("incompatible_scope");
        out["missing_requirements"] =
            json!(["matching_unit_scope_time_identity_and_support_definition"]);
        return out;
    }
    let population: BTreeSet<_> = p.members.iter().collect();
    let supported: BTreeSet<_> = s.members.iter().collect();
    if !supported.is_subset(&population) {
        out["status"] = json!("incompatible_scope");
        out["missing_requirements"] = json!(["supported_members_must_belong_to_population"]);
        return out;
    }
    out["as_of"] = json!(p.as_of);
    out["source_refs"] = json!(
        p.source_refs
            .iter()
            .chain(&s.source_refs)
            .collect::<BTreeSet<_>>()
    );
    out["source_revisions"] = json!({"population":p.revision,"supported":s.revision});
    out["duplicates_removed"] = json!({"population":p.members.len()-population.len(),"supported":s.members.len()-supported.len()});
    if population.is_empty() {
        out["status"] = json!("empty_population");
        out["missing_requirements"] = json!(["nonempty_population"]);
        return out;
    }
    let n = population.len() as u128;
    let m = supported.len() as u128;
    // Exact integer arithmetic until the final JSON percentage, with documented rounding.
    let hundredths = (m * 10_000 + n / 2) / n;
    out["status"] = json!("computed");
    out["numerator"] = json!(supported.len());
    out["denominator"] = json!(population.len());
    out["value"] = json!(hundredths as f64 / 100.);
    out
}

pub const REGISTRY: &str = include_str!("../../data/metrics/public-gtfs-operators.json");
pub async fn resolve<H: Host>(
    judge: &Judge<'_, H>,
    scope: Option<&Scope>,
    query: &str,
    traces: &mut Vec<Value>,
) -> Result<Value> {
    let intent = judge
        .score(
            query,
            &[json!({"id":"aggregation","description":query})],
            "query_aggregation",
            traces,
        )
        .await?;
    if intent[0]["score"].as_f64().unwrap_or(0.) <= 0.5 {
        return Ok(Value::Null);
    }
    let metric: Metric =
        serde_json::from_str(REGISTRY).map_err(|_| Error::new(503, "invalid_metric_registry"))?;
    let selected = judge
        .score(
            query,
            &[json!({"id":metric.id,"description":metric.definition})],
            "metric_selection",
            traces,
        )
        .await?;
    if selected[0]["score"].as_f64().unwrap_or(0.) <= 0.5 {
        let domain = judge
            .score(
                query,
                &[json!({"id":metric.id,"description":metric.definition})],
                "metric_domain",
                traces,
            )
            .await?;
        if domain[0]["score"].as_f64().unwrap_or(0.) <= 0.5 {
            return Ok(
                json!({"status":"unsupported_metric","metric_id":null,"numerator":null,"denominator":null,"value":null,"source_refs":[],"missing_requirements":["registered_metric_for_requested_unit_scope_and_operation"]}),
            );
        }
        return Ok(
            json!({"status":"needs_clarification","metric_id":null,"numerator":null,"denominator":null,"value":null,"source_refs":[],
            "missing_requirements":["supported_metric_unit_scope_and_support_definition"],
            "available_metrics":[{"id":metric.id,"definition":metric.definition}]}),
        );
    }
    // Read-only, reviewed deployment snapshot adapter. Apply the same freshly
    // checked repository scope as retrieval before exposing even counts or URLs.
    if let Some(scope) = scope {
        let allowed = metric
            .population
            .iter()
            .chain(metric.supported.iter())
            .all(|snapshot| {
                snapshot
                    .repositories
                    .iter()
                    .all(|repo| scope.public.iter().any(|p| p.eq_ignore_ascii_case(repo)))
            });
        if !allowed {
            return Ok(json!({"status":"missing_population","metric_id":metric.id,
                "numerator":null,"denominator":null,"value":null,"source_refs":[],
                "missing_requirements":["accessible_structured_sources"]}));
        }
    }
    Ok(calculate(
        &metric,
        time::OffsetDateTime::from_unix_timestamp((now() / 1000.) as i64)
            .map_err(|_| Error::new(503, "invalid_clock"))?,
    ))
}

/// No generated arithmetic reaches either the draft or the final answer.
pub fn answer(aggregation: &Value) -> Value {
    if aggregation["status"] == "computed" {
        return json!({"status":"answered","answer":format!("{}：{} / {}事業者（{:.2}%）。基準日時：{}。", s(aggregation,"definition"),aggregation["numerator"],aggregation["denominator"],aggregation["value"].as_f64().unwrap(),s(aggregation,"as_of")),"citations":[]});
    }
    let text = match s(aggregation, "status") {
        "unsupported_metric" => {
            "この質問の単位・範囲・演算に対応した集計指標は未登録です。検索で取得した関連資料は表示しますが、検索結果数から集計値を推測しません。"
        }
        "needs_clarification" => {
            "集計対象の単位・範囲・対応の定義を確認してください。現在の指標は「日本国内の公開GTFS提供バス事業者のうち、本番配信中の事業者の割合」です。"
        }
        "missing_population" => {
            "公開GTFS提供バス事業者の完全な母集団が確定していないため、対応率は算出できません。同一基準日時点の本番配信事業者集合と共通の事業者IDも必要です。検索結果数やフィード数は事業者数の代わりになりません。"
        }
        "missing_supported_set" => {
            "同一基準日時点の本番配信事業者集合が確定していないため、対応率は算出できません。"
        }
        "empty_population" => "母集団が0件のため、対応率は定義できません。",
        _ => "集計データの単位・範囲・時点・事業者IDが整合しないため、対応率は算出できません。",
    };
    json!({"status":"insufficient_evidence","answer":text,"citations":[]})
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Metric, time::OffsetDateTime) {
        let mut m: Metric = serde_json::from_str(include_str!(
            "../../data/metrics/public-gtfs-operators.json"
        ))
        .unwrap();
        let p = Snapshot {
            unit: m.unit.clone(),
            scope: m.scope.clone(),
            as_of: "2026-11-15T00:00:00Z".into(),
            valid_until: "2026-11-17T00:00:00Z".into(),
            identity_namespace: "reviewed-operator-ids-v1".into(),
            revision: "snapshot-1".into(),
            source_refs: vec!["https://example.org/registry/v1".into()],
            repositories: vec!["TrainLCD/StationAPI".into()],
            completeness_basis: "Fixture: exhaustive named registry, all pages verified".into(),
            complete: true,
            expected_count: 4,
            error_count: 0,
            members: vec!["a".into(), "b".into(), "c".into(), "a".into()],
            support_definition: m.support_definition.clone(),
        };
        let mut s = p.clone();
        s.members = vec!["a".into(), "a".into()];
        s.expected_count = 2;
        m.population = Some(p);
        m.supported = Some(s);
        (m, timestamp("2026-11-16T00:00:00Z").unwrap())
    }
    #[test]
    fn exact_distinct_ratio_and_provenance() {
        let (m, t) = fixture();
        let r = calculate(&m, t);
        assert_eq!(r["status"], "computed");
        assert_eq!(r["numerator"], 1);
        assert_eq!(r["denominator"], 3);
        assert_eq!(r["value"], 33.33);
        assert_eq!(r["duplicates_removed"]["population"], 1);
        assert_eq!(r["source_revisions"]["supported"], "snapshot-1");
    }
    #[test]
    fn refuses_missing_partial_stale_or_unproven_sets() {
        let (m, t) = fixture();
        for field in ["population", "supported"] {
            for defect in 0..8 {
                let mut m = m.clone();
                let slot = if field == "population" {
                    &mut m.population
                } else {
                    &mut m.supported
                };
                if defect == 0 {
                    *slot = None;
                } else {
                    let s = slot.as_mut().unwrap();
                    match defect {
                        1 => s.complete = false,
                        2 => s.expected_count += 1,
                        3 => s.error_count = 1,
                        4 => s.source_refs.clear(),
                        5 => s.completeness_basis.clear(),
                        6 => s.valid_until = "2026-11-15T01:00:00Z".into(),
                        _ => s.members[0] = "".into(),
                    }
                }
                let r = calculate(&m, t);
                assert!(r["value"].is_null());
                assert_eq!(
                    r["status"],
                    if field == "population" {
                        "missing_population"
                    } else {
                        "missing_supported_set"
                    }
                );
            }
        }
    }
    #[test]
    fn rejects_incompatible_identity_scope_time_and_outsiders() {
        let (m, t) = fixture();
        for defect in 0..6 {
            let mut m = m.clone();
            let s = m.supported.as_mut().unwrap();
            match defect {
                0 => s.unit = "feed".into(),
                1 => s.scope = "Tokyo".into(),
                2 => s.as_of = "2026-11-14T00:00:00Z".into(),
                3 => s.identity_namespace = "different".into(),
                4 => s.support_definition = "staging".into(),
                _ => s.members[0] = "outsider".into(),
            }
            let r = calculate(&m, t);
            assert_eq!(r["status"], "incompatible_scope");
            assert!(r["value"].is_null());
        }
    }
    #[test]
    fn zero_support_is_zero_and_zero_population_is_undefined() {
        let (mut m, t) = fixture();
        let s = m.supported.as_mut().unwrap();
        s.members.clear();
        s.expected_count = 0;
        assert_eq!(calculate(&m, t)["value"], 0.);
        let p = m.population.as_mut().unwrap();
        p.members.clear();
        p.expected_count = 0;
        let r = calculate(&m, t);
        assert_eq!(r["status"], "empty_population");
        assert!(r["value"].is_null());
    }
}

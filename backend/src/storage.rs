use crate::runtime::*;
use regex::Regex;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    sync::LazyLock,
};
#[derive(Clone)]
pub struct Scope {
    pub public: Vec<String>,
    pub feedback: Option<String>,
}
const SCOPE: &str = "((s.kind<>'feedback' AND lower(s.repo) IN (SELECT value FROM json_each(?))) OR (s.kind='feedback' AND lower(s.repo)=?))";
fn scope_params(scope: Option<&Scope>) -> Vec<Value> {
    scope
        .map(|s| {
            vec![
                json!(serde_json::to_string(&s.public).unwrap()),
                json!(s.feedback),
            ]
        })
        .unwrap_or_default()
}
pub fn local_references(id: &str, text: &str) -> Vec<String> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"#([1-9][0-9]*)\b").unwrap());
    let repo = id.split(['#', ':']).next().unwrap_or("");
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for cap in RE.captures_iter(text) {
        let at = cap.get(0).unwrap().start();
        if text[..at]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '/')
        {
            continue;
        }
        let r = format!("{repo}#{}", &cap[1]);
        if seen.insert(r.clone()) {
            result.push(r);
        }
    }
    result
}
pub fn split_passages(body: &str) -> Vec<String> {
    // Use Unicode boundaries and count UTF-16 units, avoiding split surrogate pairs.
    let mut out = Vec::new();
    let mut current = String::new();
    static HEADINGS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^#{1,6} ").unwrap());
    let mut boundaries = vec![0];
    boundaries.extend(
        HEADINGS
            .find_iter(body)
            .map(|m| m.start())
            .filter(|i| *i > 0),
    );
    boundaries.push(body.len());
    for paragraph in boundaries
        .windows(2)
        .flat_map(|range| body[range[0]..range[1]].split("\n\n"))
    {
        if !current.is_empty()
            && current.encode_utf16().count() + paragraph.encode_utf16().count() + 2 > 2400
        {
            out.push(std::mem::take(&mut current));
        }
        let mut rest = paragraph;
        while rest.encode_utf16().count() > 2400 {
            let mut size = 0;
            let end = rest
                .char_indices()
                .find_map(|(i, c)| {
                    size += c.len_utf16();
                    (size > 2400).then_some(i)
                })
                .unwrap();
            out.push(rest[..end].to_string());
            rest = &rest[end..];
        }
        if !rest.is_empty() {
            if !current.is_empty() {
                current.push_str("\n\n");
            }
            current.push_str(rest);
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}
pub async fn save_source(
    h: &impl Host,
    source: Value,
    snapshot: Option<(&str, &str)>,
) -> Result<()> {
    if s(&source, "body").len() > 600_000 {
        return Err(Error::new(422, "source_size_budget_exceeded"));
    }
    let clause = if snapshot.is_some() {
        "EXISTS(SELECT 1 FROM repositories WHERE repo=? AND docs_commit=?)"
    } else {
        "1=1"
    };
    let guard: Vec<Value> = snapshot
        .map(|(r, c)| vec![json!(r), json!(c)])
        .unwrap_or_default();
    let mut values: Vec<Value> = ["id", "repo", "kind", "title", "url", "body"]
        .iter()
        .map(|k| source[*k].clone())
        .collect();
    values.extend([
        json!(source["metadata"].to_string()),
        source["updated_at"].clone(),
    ]);
    values.extend(guard.clone());
    let mut statements = vec![
        statement(
            format!(
                "INSERT INTO sources(id,repo,kind,title,url,body,metadata,updated_at) SELECT ?,?,?,?,?,?,?,? WHERE {clause} ON CONFLICT(id) DO UPDATE SET repo=excluded.repo,kind=excluded.kind,title=excluded.title,url=excluded.url,body=excluded.body,metadata=excluded.metadata,updated_at=excluded.updated_at"
            ),
            values,
        ),
        statement(
            format!("DELETE FROM passages WHERE source_id=? AND {clause}"),
            [vec![source["id"].clone()], guard.clone()].concat(),
        ),
    ];
    for (i, text) in split_passages(s(&source, "body")).into_iter().enumerate() {
        statements.push(statement(
            format!(
                "INSERT INTO passages(id,source_id,ordinal,text) SELECT ?,?,?,? WHERE {clause}"
            ),
            [
                vec![
                    json!(format!("{}:{i}", s(&source, "id"))),
                    source["id"].clone(),
                    json!(i),
                    json!(text),
                ],
                guard.clone(),
            ]
            .concat(),
        ));
    }
    batch(h, statements).await?;
    Ok(())
}
pub async fn delete_source(h: &impl Host, id: &str) -> Result<()> {
    batch(
        h,
        vec![
            statement("DELETE FROM passages WHERE source_id=?", vec![json!(id)]),
            statement("DELETE FROM sources WHERE id=?", vec![json!(id)]),
        ],
    )
    .await?;
    Ok(())
}
pub async fn purge(h: &impl Host, repo: &str) -> Result<()> {
    batch(
        h,
        vec![
            statement(
                "DELETE FROM passages WHERE source_id IN (SELECT id FROM sources WHERE repo=?)",
                vec![json!(repo)],
            ),
            statement("DELETE FROM sources WHERE repo=?", vec![json!(repo)]),
            statement("DELETE FROM repositories WHERE repo=?", vec![json!(repo)]),
        ],
    )
    .await?;
    Ok(())
}
pub async fn plan(
    h: &impl Host,
    query: &str,
    scope: Option<&Scope>,
    max: usize,
    traces: &mut Vec<Value>,
) -> Result<Vec<String>> {
    let start = now();
    let mut after = String::new();
    let mut candidates = Vec::new();
    let mut scored = Vec::new();
    loop {
        let sql = format!(
            "SELECT s.id,s.kind,s.title,s.metadata, CASE WHEN s.kind='doc' THEN substr(s.body,1,1400)||' … '||substr(s.body,max(1,length(s.body)/4),400)||' … '||substr(s.body,max(1,length(s.body)/2),400)||' … '||substr(s.body,max(1,3*length(s.body)/4),400)||' … '||substr(s.body,-400) ELSE substr(s.body,1,480) END AS introduction, substr(s.body,1,60)||' … '||substr(s.body,max(1,length(s.body)/2-20),40)||' … '||substr(s.body,-40) AS sample FROM sources s JOIN repositories r ON s.repo=r.repo WHERE {} AND (s.kind<>'pr' OR instr(s.body,char(10)||'PENDING'||char(10))=0) AND s.id>? ORDER BY s.id LIMIT ?",
            if scope.is_some() { SCOPE } else { "1=1" }
        );
        let mut params = scope_params(scope);
        params.extend([
            json!(after),
            json!((max.saturating_sub(candidates.len()) + 1).min(540)),
        ]);
        let rows = db(h, &sql, params).await?;
        if candidates.len() + rows.len() > max {
            return Err(Error::new(422, "document_screening_budget_exceeded"));
        }
        if rows.is_empty() {
            break;
        }
        let next = s(rows.last().unwrap(), "id").to_string();
        if next <= after {
            return Err(Error::new(503, "invalid_document_cursor"));
        }
        after = next;
        let descriptions:Vec<_>=rows.iter().map(|r|json!({"id":r["id"],"description":format!("{}\n{} ({})\n{}\nBody excerpts: {}\n{}",s(r,"title"),s(r,"id"),s(r,"kind"),s(r,"metadata"),s(r,"sample"),s(r,"introduction"))})).collect();
        for chunk in descriptions.chunks(64) {
            scored.extend(
                array(
                    &decision(
                        json!({"op":"score","query":query,"candidates":chunk,"allow_partial":true}),
                    )?["scores"],
                )?
                .iter()
                .cloned(),
            );
        }
        for row in &rows {
            candidates.push(json!({"id":row["id"],"references":local_references(s(row,"id"),&format!("{}\n{}",s(row,"sample"),s(row,"introduction")))}));
        }
        if rows.len() < 540 {
            break;
        }
    }
    scored.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .unwrap_or(0.)
            .total_cmp(&a["score"].as_f64().unwrap_or(0.))
    });
    let result =
        decision(json!({"op":"select_scored","candidates":candidates,"scores":scored,"limit":30}))?;
    let ids: Vec<String> = array(&result["ids"])?
        .iter()
        .filter_map(|v| v.as_str().map(String::from))
        .collect();
    traces.push(trace(
        "document_screening",
        scored.len(),
        ids.iter().take(12).map(|s| json!(s)).collect(),
        start,
    ));
    Ok(ids)
}
pub async fn passages(h: &impl Host, ids: &[String], scope: Option<&Scope>) -> Result<Vec<Value>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let filter = if scope.is_some() {
        format!(" AND {SCOPE} AND (s.kind<>'pr' OR instr(s.body,char(10)||'PENDING'||char(10))=0)")
    } else {
        String::new()
    };
    let sql = format!(
        "SELECT p.*,s.repo,s.kind,s.title,s.url,s.metadata,s.updated_at,r.tag AS release_tag,r.url AS release_url,r.published_at AS release_published_at FROM passages p JOIN sources s ON s.id=p.source_id LEFT JOIN github_release_commits c ON s.kind='pr' AND json_extract(s.metadata,'$.merged_at') IS NOT NULL AND c.repo=s.repo AND c.sha=json_extract(s.metadata,'$.merge_commit_sha') LEFT JOIN github_releases r ON r.repo=c.repo WHERE s.id IN (SELECT value FROM json_each(?)){filter} ORDER BY s.id,p.ordinal LIMIT 4001"
    );
    let rows = db(
        h,
        &sql,
        [
            vec![json!(serde_json::to_string(ids).unwrap())],
            scope_params(scope),
        ]
        .concat(),
    )
    .await?;
    if rows.len() > 4000 {
        return Err(Error::new(422, "passage_screening_budget_exceeded"));
    }
    let mut out = Vec::new();
    for mut p in rows {
        let mut metadata: Value = serde_json::from_str(s(&p, "metadata"))
            .map_err(|_| Error::new(503, "invalid_stored_metadata"))?;
        if !p["release_tag"].is_null()
            && !p["release_url"].is_null()
            && !p["release_published_at"].is_null()
        {
            metadata["release_status"] = json!("included_in_github_release");
            metadata["github_release"] = json!({"tag":p["release_tag"],"url":p["release_url"],"published_at":p["release_published_at"]});
        }
        p["metadata"] = metadata;
        for key in ["release_tag", "release_url", "release_published_at"] {
            p.as_object_mut().unwrap().remove(key);
        }
        out.push(p);
    }
    Ok(out)
}
pub fn rank(
    query: &str,
    passages: &[Value],
    page: &[Value],
    traces: &mut Vec<Value>,
) -> Result<Vec<Value>> {
    let start = now();
    let mut contexts = HashMap::new();
    for p in passages {
        if p["ordinal"] == 0 {
            contexts.insert(
                s(p, "source_id"),
                format!(
                    "{}\nBody excerpt: {}",
                    s(p, "title"),
                    s(p, "text").chars().take(480).collect::<String>()
                ),
            );
        }
    }
    let mut reverse: HashMap<String, Vec<String>> = HashMap::new();
    for p in passages {
        for r in local_references(s(p, "source_id"), s(p, "text")) {
            if contexts.contains_key(r.as_str()) && r != s(p, "source_id") {
                let v = reverse.entry(r).or_default();
                let id = s(p, "source_id").to_string();
                if !v.contains(&id) {
                    v.push(id);
                }
            }
        }
    }
    let mut scores = Vec::new();
    for chunk in page.chunks(64) {
        let candidates:Vec<_>=chunk.iter().map(|p|{
   let mut links=local_references(s(p,"source_id"),s(p,"text"));links.extend(reverse.get(s(p,"source_id")).cloned().unwrap_or_default());let mut seen=HashSet::new();
   let linked=links.iter().filter(|id|seen.insert(id.as_str())).filter_map(|id|contexts.get(id.as_str()).map(|c|format!("{id}: {c}"))).take(3).collect::<Vec<_>>().join("; ");
   json!({"id":p["id"],"description":format!("{}\nSource: {}\nRepository: {}\nMetadata: {}\n{}\nExplicitly linked sources: {linked}",s(p,"title"),s(p,"source_id"),s(p,"repo"),p["metadata"],s(p,"text"))})
  }).collect();
        scores.extend(
            array(
                &decision(json!({"op":"score","query":query,"candidates":candidates}))?["scores"],
            )?
            .iter()
            .cloned(),
        );
    }
    scores.retain(|r| r["score"].as_f64().unwrap_or(0.) > 0.5);
    scores.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .unwrap()
            .total_cmp(&a["score"].as_f64().unwrap())
    });
    let by_id: HashMap<_, _> = passages.iter().map(|p| (s(p, "id"), p)).collect();
    let mut out = Vec::new();
    for (i, row) in scores.iter().enumerate() {
        let mut p = by_id[s(row, "id")].clone();
        p["citation"] = json!(format!("p{}", i + 1));
        p["relevance"] = row["score"].clone();
        out.push(p);
    }
    traces.push(trace(
        "passage_scoring",
        page.len(),
        out.iter().take(12).map(|p| p["id"].clone()).collect(),
        start,
    ));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn passage_boundaries_preserve_unicode_and_size_budget() {
        let text = "😀測位".repeat(2000);
        let parts = split_passages(&text);
        assert_eq!(parts.concat(), text);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= 2400));
    }
    #[test]
    fn references_do_not_follow_cross_repository_links() {
        assert_eq!(
            local_references(
                "TrainLCD/App#1",
                "#2 #2 https://github.com/Other/App/issues/#3 foo#4 #5"
            ),
            vec!["TrainLCD/App#2", "TrainLCD/App#5"]
        );
    }
}

use crate::{github as gh, runtime::*, storage};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::collections::HashSet;
fn discussion(rows: &[Value], label: &str) -> String {
    rows.iter()
        .map(|r| {
            format!(
                "\n\n## {label}: {}\n{}\n{}\n{}\n{}",
                s(&r["user"], "login"),
                s(r, "html_url"),
                s(r, "path"),
                s(r, "state"),
                s(r, "body")
            )
        })
        .collect()
}
fn commit(s: &str) -> bool {
    s.len() == 40
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub async fn run(h: &impl Host, c: &Config, job: &Value) -> Result<()> {
    let kind = s(job, "type");
    if kind == "org" {
        let page = job["page"]
            .as_u64()
            .filter(|v| *v >= 1)
            .ok_or_else(|| Error::new(400, "invalid_sync_job"))?;
        let repos = gh::get(
            h,
            c,
            &format!(
                "/orgs/{}/repos?per_page=100&page={page}&sort=full_name",
                encode(&c.github_org)
            ),
        )
        .await?;
        for repo in array(&repos)? {
            gh::assert_repo(c, s(repo, "full_name"))?;
            if repo["disabled"] != true {
                enqueue(h, json!({"type":"repo","repo":repo["full_name"]})).await?;
            }
        }
        if array(&repos)?.len() == 100 {
            enqueue(h, json!({"type":"org","page":page+1})).await?;
        }
        return Ok(());
    }
    let repo = s(job, "repo");
    gh::assert_repo(c, repo)?;
    let prefix = format!("/repos/{repo}");
    match kind {
        "repo" => {
            let row = gh::get(h, c, &prefix).await?;
            db(h,"INSERT INTO repositories(repo,description,default_branch) VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET description=excluded.description,default_branch=excluded.default_branch",vec![json!(repo),json!(s(&row,"description")),row["default_branch"].clone()]).await?;
            let old = db(
                h,
                "SELECT issues_dispatched_at FROM repositories WHERE repo=?",
                vec![json!(repo)],
            )
            .await?;
            let mut next = json!({"type":"issues","repo":repo,"page":1,"started":iso(now())});
            if let Some(old) = old.first()
                && let Ok(time) = time::OffsetDateTime::parse(
                    s(old, "issues_dispatched_at"),
                    &time::format_description::well_known::Rfc3339,
                )
            {
                next["since"] = json!(iso(
                    time.unix_timestamp_nanos() as f64 / 1_000_000. - 600_000.
                ));
            }
            enqueue(h, next).await?;
            enqueue(h, json!({"type":"docs","repo":repo})).await?;
            enqueue(h, json!({"type":"releases","repo":repo})).await?;
        }
        "issues" => {
            let page = job["page"]
                .as_u64()
                .filter(|v| *v >= 1)
                .ok_or_else(|| Error::new(400, "invalid_sync_job"))?;
            let since = if s(job, "since").is_empty() {
                String::new()
            } else {
                format!("&since={}", encode(s(job, "since")))
            };
            let rows=gh::get(h,c,&format!("{prefix}/issues?state=all&sort=updated&direction=asc&per_page=100&page={page}{since}")).await?;
            for issue in array(&rows)? {
                enqueue(
                    h,
                    json!({"type":"issue","repo":repo,"number":issue["number"]}),
                )
                .await?;
            }
            if array(&rows)?.len() == 100 {
                let mut next = job.clone();
                next["page"] = json!(page + 1);
                enqueue(h, next).await?;
            } else {
                db(h,"UPDATE repositories SET issues_dispatched_at=? WHERE repo=? AND (issues_dispatched_at IS NULL OR issues_dispatched_at<?)",vec![job["started"].clone(),json!(repo),job["started"].clone()]).await?;
            }
        }
        "issue" => {
            let number = job["number"]
                .as_u64()
                .filter(|v| *v >= 1 && *v <= 9_007_199_254_740_991)
                .ok_or_else(|| Error::new(400, "invalid_issue_number"))?;
            let issue = gh::get(h, c, &format!("{prefix}/issues/{number}")).await?;
            let comments = gh::all(h, c, &format!("{prefix}/issues/{number}/comments")).await?;
            let mut body = format!("{}{}", s(&issue, "body"), discussion(&comments, "Comment"));
            let mut metadata = json!({"number":issue["number"],"state":issue["state"],"state_reason":issue["state_reason"],"labels":array(&issue["labels"])?.iter().map(|l|l["name"].clone()).collect::<Vec<_>>(),"author":issue["user"]["login"],"release_status":"unknown"});
            let is_pr = !issue["pull_request"].is_null();
            if is_pr {
                let pr = gh::get(h, c, &format!("{prefix}/pulls/{number}")).await?;
                if pr["changed_files"].as_u64().unwrap_or(0) > 3000 {
                    return Err(Error::new(422, "github_changed_files_limit_exceeded"));
                }
                let reviews = gh::all(h, c, &format!("{prefix}/pulls/{number}/reviews")).await?;
                let inline = gh::all(h, c, &format!("{prefix}/pulls/{number}/comments")).await?;
                let files = gh::all(h, c, &format!("{prefix}/pulls/{number}/files")).await?;
                let pending: HashSet<_> = reviews
                    .iter()
                    .filter(|r| r["state"] == "PENDING")
                    .filter_map(|r| r["id"].as_u64())
                    .collect();
                body.push_str(&discussion(
                    &reviews
                        .into_iter()
                        .filter(|r| !pending.contains(&r["id"].as_u64().unwrap_or(0)))
                        .collect::<Vec<_>>(),
                    "Review",
                ));
                body.push_str(&discussion(
                    &inline
                        .into_iter()
                        .filter(|r| {
                            !pending.contains(&r["pull_request_review_id"].as_u64().unwrap_or(0))
                        })
                        .collect::<Vec<_>>(),
                    "Inline review",
                ));
                body.push_str("\n\n## Changed files\n");
                body.push_str(
                    &files
                        .iter()
                        .map(|f| format!("{}: {}", s(f, "status"), s(f, "filename")))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
                for key in ["merged_at", "merge_commit_sha", "draft"] {
                    metadata[key] = pr[key].clone();
                }
                metadata["base_branch"] = pr["base"]["ref"].clone();
                metadata["head_branch"] = pr["head"]["ref"].clone();
            }
            let kind = if is_pr {
                "pr"
            } else if repo.eq_ignore_ascii_case(&format!("{}/Issues", c.github_org)) {
                "feedback"
            } else {
                "issue"
            };
            storage::save_source(h,json!({"id":format!("{repo}#{number}"),"repo":repo,"kind":kind,"title":issue["title"],"url":issue["html_url"],"body":if body.is_empty(){"(No body)"}else{&body},"metadata":metadata,"updated_at":issue["updated_at"]}),None).await?;
        }
        "docs" | "doc" | "releases" => {
            let rows = db(
                h,
                "SELECT * FROM repositories WHERE repo=?",
                vec![json!(repo)],
            )
            .await?;
            let row = rows
                .first()
                .ok_or_else(|| Error::new(503, "repository_not_synced"))?;
            if kind == "releases" {
                return release(h, c, repo).await;
            }
            if kind == "docs" {
                let commit = gh::get(
                    h,
                    c,
                    &format!("{prefix}/commits/{}", encode(s(row, "default_branch"))),
                )
                .await?;
                let tree = gh::get(
                    h,
                    c,
                    &format!(
                        "{prefix}/git/trees/{}?recursive=1",
                        s(&commit["commit"]["tree"], "sha")
                    ),
                )
                .await?;
                if tree["truncated"] == true {
                    return Err(Error::new(422, "github_tree_truncated"));
                }
                let docs: Vec<_> = array(&tree["tree"])?
                    .iter()
                    .filter(|f| f["type"] == "blob" && gh::is_document(s(f, "path")))
                    .collect();
                if docs
                    .iter()
                    .any(|d| d["size"].as_u64().unwrap_or(0) > 600_000)
                {
                    return Err(Error::new(422, "source_size_budget_exceeded"));
                }
                let sha = s(&commit, "sha");
                db(
                    h,
                    "UPDATE repositories SET docs_commit=? WHERE repo=?",
                    vec![json!(sha), json!(repo)],
                )
                .await?;
                for doc in &docs {
                    enqueue(h,json!({"type":"doc","repo":repo,"path":doc["path"],"sha":doc["sha"],"commit":sha})).await?;
                }
                let existing = db(
                    h,
                    "SELECT id FROM sources WHERE repo=? AND kind='doc'",
                    vec![json!(repo)],
                )
                .await?;
                let keep: HashSet<_> = docs
                    .iter()
                    .map(|d| format!("{repo}:{}", s(d, "path")))
                    .collect();
                for item in existing {
                    let id = s(&item, "id");
                    if !keep.contains(id) {
                        batch(h,vec![statement("DELETE FROM passages WHERE source_id=? AND EXISTS(SELECT 1 FROM repositories WHERE repo=? AND docs_commit=?)",vec![json!(id),json!(repo),json!(sha)]),statement("DELETE FROM sources WHERE id=? AND EXISTS(SELECT 1 FROM repositories WHERE repo=? AND docs_commit=?)",vec![json!(id),json!(repo),json!(sha)])]).await?;
                    }
                }
            } else {
                if row["docs_commit"] != job["commit"] {
                    return Ok(());
                }
                let blob = gh::get(h, c, &format!("{prefix}/git/blobs/{}", s(job, "sha"))).await?;
                if blob["encoding"] != "base64" {
                    return Err(Error::new(502, "unsupported_blob_encoding"));
                }
                let bytes = STANDARD
                    .decode(
                        s(&blob, "content")
                            .chars()
                            .filter(|c| !c.is_whitespace())
                            .collect::<String>(),
                    )
                    .map_err(|_| Error::new(502, "invalid_blob_encoding"))?;
                let body = String::from_utf8(bytes)
                    .map_err(|_| Error::new(502, "invalid_blob_encoding"))?;
                let path = s(job, "path");
                let encoded = path.split('/').map(encode).collect::<Vec<_>>().join("/");
                let sha = s(job, "commit");
                storage::save_source(h,json!({"id":format!("{repo}:{path}"),"repo":repo,"kind":"doc","title":path,"url":format!("https://github.com/{repo}/blob/{sha}/{encoded}"),"body":if body.is_empty(){"(Empty document)"}else{&body},"metadata":{"path":path,"branch":row["default_branch"],"commit":sha,"blob_sha":job["sha"]},"updated_at":iso(now())}),Some((repo,sha))).await?;
            }
        }
        _ => return Err(Error::new(400, "invalid_sync_job")),
    }
    Ok(())
}
const LATEST: &str = "query($owner: String!, $repo: String!) { repository(owner: $owner, name: $repo) { latestRelease { tagName url publishedAt isDraft isPrerelease tagCommit { oid } } } }";
const HISTORY: &str = "query($owner: String!, $repo: String!, $commit: GitObjectID!, $after: String) { repository(owner: $owner, name: $repo) { object(oid: $commit) { ... on Commit { history(first: 100, after: $after) { totalCount nodes { oid } pageInfo { hasNextPage endCursor } } } } } }";
async fn history(
    h: &impl Host,
    c: &Config,
    owner: &str,
    repo: &str,
    sha: &str,
) -> Result<Vec<String>> {
    let mut commits = HashSet::new();
    let mut after = Value::Null;
    for _ in 0..300 {
        let data = gh::graph(
            h,
            c,
            HISTORY,
            json!({"owner":owner,"repo":repo,"commit":sha,"after":after}),
        )
        .await?;
        let hist = &data["repository"]["object"]["history"];
        let total = hist["totalCount"]
            .as_u64()
            .filter(|v| *v > 0)
            .ok_or_else(|| Error::new(502, "invalid_github_release_history"))?;
        if total > 30000 {
            return Err(Error::new(422, "release_history_budget_exceeded"));
        }
        for node in array(&hist["nodes"])? {
            let oid = s(node, "oid");
            if !commit(oid) {
                return Err(Error::new(502, "invalid_github_release_history"));
            }
            commits.insert(oid.to_string());
        }
        if hist["pageInfo"]["hasNextPage"] == false {
            if commits.len() != total as usize || !commits.contains(sha) {
                return Err(Error::new(502, "incomplete_github_release_history"));
            }
            let mut out: Vec<_> = commits.into_iter().collect();
            out.sort();
            return Ok(out);
        }
        let next = hist["pageInfo"]["endCursor"].clone();
        if next == after || next.as_str().is_none_or(str::is_empty) {
            return Err(Error::new(502, "invalid_github_release_cursor"));
        }
        after = next;
    }
    Err(Error::new(422, "release_history_budget_exceeded"))
}
async fn release(h: &impl Host, c: &Config, name: &str) -> Result<()> {
    let checked = iso(now());
    let (owner, repo) = name.split_once('/').unwrap();
    let data = gh::graph(h, c, LATEST, json!({"owner":owner,"repo":repo})).await?;
    if data["repository"].is_null() {
        return Err(Error::new(502, "github_release_repository_unavailable"));
    }
    let r = &data["repository"]["latestRelease"];
    let published =
        if r["isDraft"] == false && r["isPrerelease"] == false && !s(r, "publishedAt").is_empty() {
            r.clone()
        } else {
            Value::Null
        };
    let sha = &published["tagCommit"]["oid"];
    if !sha.is_null() && !commit(sha.as_str().unwrap_or("")) {
        return Err(Error::new(502, "invalid_github_release_commit"));
    }
    let snapshot = h.call("uuid", Value::Null).await?;
    let prev = db(
        h,
        "SELECT commit_sha FROM github_releases WHERE repo=?",
        vec![json!(name)],
    )
    .await?;
    if prev.first().is_some_and(|p| p["commit_sha"] == *sha) {
        db(h,"UPDATE github_releases SET tag=?,url=?,published_at=?,checked_at=?,snapshot_id=? WHERE repo=? AND commit_sha IS ? AND checked_at<=?",vec![published["tagName"].clone(),published["url"].clone(),published["publishedAt"].clone(),json!(checked),snapshot,json!(name),sha.clone(),json!(checked)]).await?;
        return Ok(());
    }
    let commits = if let Some(sha) = sha.as_str() {
        history(h, c, owner, repo, sha).await?
    } else {
        vec![]
    };
    let guard = "EXISTS (SELECT 1 FROM github_releases WHERE repo=? AND snapshot_id=?)";
    batch(h,vec![statement("INSERT INTO github_releases(repo,tag,commit_sha,published_at,url,checked_at,snapshot_id) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM repositories WHERE repo=?) ON CONFLICT(repo) DO UPDATE SET tag=excluded.tag,commit_sha=excluded.commit_sha,published_at=excluded.published_at,url=excluded.url,checked_at=excluded.checked_at,snapshot_id=excluded.snapshot_id WHERE github_releases.checked_at<=excluded.checked_at",vec![json!(name),published["tagName"].clone(),sha.clone(),published["publishedAt"].clone(),published["url"].clone(),json!(checked),snapshot.clone(),json!(name)]),statement(format!("DELETE FROM github_release_commits WHERE repo=? AND {guard}"),vec![json!(name),json!(name),snapshot.clone()]),statement(format!("INSERT INTO github_release_commits(repo,sha) SELECT ?,value FROM json_each(?) WHERE {guard}"),vec![json!(name),json!(serde_json::to_string(&commits).unwrap()),json!(name),snapshot])]).await?;
    Ok(())
}

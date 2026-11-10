"use strict";
const $ = (id) => document.getElementById(id);
const settings = $("settings-dialog");
const SAVED_TOKEN_KEY = "decisionrag.apiToken";
let token = "";
let feedbackRequested = false;
let session = 0;
let searching = false;
let connecting = false;
let syncing = false;
let refreshing = false;
const RESULT_PAGE_SIZE = 5;
let resultEvidence = [];
let resultPage = 0;
const requests = new Set();
const number = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toLocaleString("ja-JP") : "—";
const statuses = {
  retrieved: [
    "関連する本文が見つかりました",
    "出典を開き、対象のバージョンや時点も確認してください。",
  ],
  empty: [
    "根拠が見つかりませんでした",
    "質問を変えるか、同期状況を確認してください。",
  ],
  answered: ["検証済みの回答", ""],
  summarized: ["確認できた内容の要約", ""],
  evidence_ready: [
    "回答に使える根拠があります",
    "回答生成モデルは未設定です。以下の根拠を確認してください。",
  ],
  insufficient_evidence: [
    "回答に十分な根拠がありません",
    "資料から質問に答えられる内容を確認できませんでした。",
  ],
  conflicting_evidence: [
    "根拠に矛盾があります",
    "同じ対象・時点について異なる記述があるため、回答を保留しました。",
  ],
  verification_failed: [
    "回答が資料の内容に沿っているか確認できませんでした",
    "検索で見つかった関連資料は、下の一覧からご覧いただけます。",
  ],
  generation_unavailable: ["要約を生成できませんでした", "検索で見つかった資料を表示します。"],
};
const errors = {
  unauthorized: "認証に失敗しました。API_TOKENを確認して接続し直してください。",
  authentication_not_configured: "サーバーにAPI_TOKENが設定されていません。",
  public_search_rate_limited: "検索回数の上限に達しました。少し待ってから再実行してください。",
  public_search_unavailable: "公開資料の検索は現在利用できません。",
  jev_not_configured: "サーバーにJevのAPIキーが設定されていません。",
  upstream_http_401:
    "外部サービスの認証に失敗しました。サーバーのAPIキーを確認してください。",
  upstream_http_403: "外部サービスの権限または利用制限を確認してください。",
  upstream_http_429:
    "外部サービスの利用制限に達しました。時間をおいて再実行してください。",
  upstream_network_error:
    "外部サービスと通信できませんでした。時間をおいて再実行してください。",
  upstream_timeout:
    "外部サービスの応答がタイムアウトしました。再実行してください。",
  upstream_context_limit: "資料が長すぎるため検索を完了できませんでした。",
  document_screening_budget_exceeded:
    "検索する文書数の上限を超えました。管理者に設定の確認を依頼してください。",
  passage_screening_budget_exceeded: "検索する本文区間数の上限を超えました。",
};
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
/** Render text or rebuild pre-rendered markup with a restricted set of elements. */
function markdownContent(text, html, className = "", baseUrl) {
  const root = element("div", className + " markdown-body");
  if (typeof html !== "string") {
    root.classList.add("plain-text");
    root.textContent = String(text || "");
    return root;
  }
  // Parse pre-rendered HTML inertly, then build only allowed elements. Never
  // insert API-provided attributes, scripts or images directly into the page.
  const template = document.createElement("template");
  template.innerHTML = html;
  const allowed = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
    "em", "strong", "del", "br", "hr", "a", "img", "table", "thead", "tbody", "tr", "th", "td", "input"]);
  function append(source, target) {
    for (const child of source.childNodes) {
      if (child.nodeType === 3) { target.append(document.createTextNode(child.textContent)); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName.toLowerCase();
      if (!allowed.has(tag) || tag === "input" && child.getAttribute("type") !== "checkbox") continue;
      const image = tag === "img";
      const imageLabel = image ? child.getAttribute("alt") || "画像を開く" : "";
      if (image && target.closest("a")) {
        target.append(imageLabel);
        continue;
      }
      const node = image ? element("a", "", imageLabel) : element(tag);
      if (tag === "a" || image) {
        const href = child.getAttribute(image ? "src" : "href");
        try {
          const url = href && new URL(href, baseUrl || undefined);
          if (url && ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password) {
            node.href = url.href; node.target = "_blank"; node.rel = "noopener noreferrer";
          }
        } catch {}
        if (child.hasAttribute("title")) node.title = child.getAttribute("title");
      }
      if (tag === "code" && /^language-[\w-]+$/.test(child.className)) node.className = child.className;
      if (["ul", "ol", "li"].includes(tag) && ["contains-task-list", "task-list-item"].includes(child.className)) node.className = child.className;
      if (tag === "ol" && /^\d{1,9}$/.test(child.getAttribute("start"))) node.setAttribute("start", child.getAttribute("start"));
      if (["th", "td"].includes(tag) && ["left", "right", "center"].includes(child.getAttribute("align"))) node.setAttribute("align", child.getAttribute("align"));
      if (tag === "input") {
        node.setAttribute("type", "checkbox"); node.disabled = true;
        if (child.hasAttribute("checked")) node.setAttribute("checked", "");
      }
      target.append(node);
      append(child, node);
    }
  }
  append(template.content, root);
  return root;
}
function notice(message, kind = "", target = $("notice")) {
  target.textContent = message;
  target.className = "notice " + kind;
}
function settingsNotice(message, kind = "") {
  notice(message, kind, $("settings-notice"));
}
function controls() {
  $("connect-button").disabled = connecting;
  $("connect-button").textContent = connecting ? "接続中…" : "接続";
  const searchButton = $("search-button");
  searchButton.disabled = searching;
  searchButton.setAttribute("aria-label", searching ? "検索中" : "検索");
  $("include-summary").disabled = searching;
  $("include-feedback").disabled = searching;
  $("sync-button").disabled = !token || syncing;
  $("sync-button").textContent = syncing ? "登録中…" : "GitHubから取り込む";
  $("refresh-button").disabled = !token || refreshing;
  $("token").disabled = connecting;
  $("results").setAttribute("aria-busy", String(searching));
}
function clearResults() {
  if (resultEvidence.some((item) => location.hash === "#" + evidenceId(item.citation))) {
    history.replaceState(history.state, "", location.pathname + location.search);
  }
  resultEvidence = [];
  resultPage = 0;
  document.querySelectorAll(".result-pagination").forEach((nav) => {
    nav.hidden = true;
    nav.querySelector("[data-page-label]").textContent = "";
    nav.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  });
  $("evidence-list").replaceChildren();
  $("trace-list").replaceChildren();
  $("answer-panel").replaceChildren();
  $("answer-panel").hidden = true;
  $("trace-panel").hidden = true;
  $("result-summary").hidden = true;
  $("empty-state").hidden = false;
}
function readSavedToken() {
  try {
    return localStorage.getItem(SAVED_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}
function saveToken(credential) {
  try {
    localStorage.setItem(SAVED_TOKEN_KEY, credential);
  } catch {
    // Browsers that block storage can still connect for the current page.
  }
}
function forgetSavedToken(credential) {
  if (!credential || readSavedToken() !== credential) return;
  try {
    localStorage.removeItem(SAVED_TOKEN_KEY);
  } catch {
    // Browser settings can block storage access.
  }
}
function disconnect(message = "接続を解除しました。") {
  session++;
  for (const controller of requests) controller.abort();
  requests.clear();
  forgetSavedToken(token);
  token = "";
  feedbackRequested = false;
  searching = false;
  connecting = false;
  syncing = false;
  refreshing = false;
  $("token").value = "";
  $("connect-form").hidden = false;
  $("disconnect-button").hidden = true;
  $("connection-state").textContent = "公開資料のみ";
  $("connection-state").className = "badge";
  $("repo-count").textContent = "—";
  $("source-count").textContent = "—";
  $("sync-summary").textContent = "接続後に表示します。";
  $("sync-updated").textContent = "";
  $("sync-error-list").replaceChildren();
  $("sync-errors").hidden = true;
  $("include-feedback").checked = false;
  clearResults();
  controls();
  notice(message);
  settingsNotice(message);
  if (settings.open) $("token").focus();
}
async function api(path, options = {}, credential = token) {
  const controller = new AbortController();
  requests.add(controller);
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const response = await fetch(path, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      headers: {
        ...(credential ? { Authorization: "Bearer " + credential } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (response.status === 401 && credential) {
      if (credential === token)
        disconnect("認証が無効になりました。接続し直してください。");
      else forgetSavedToken(credential);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error("サーバーから読み取れない応答が返りました。");
    }
    if (!response.ok) {
      throw new Error(
        errors[data.error] ||
          "リクエストに失敗しました（HTTP " + response.status + "）。",
      );
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("リクエストが中断されたか、タイムアウトしました。");
    if (error instanceof TypeError)
      throw new Error(
        "サーバーに接続できません。ネットワークを確認してください。",
      );
    throw error;
  } finally {
    clearTimeout(timeout);
    requests.delete(controller);
  }
}
function renderSync(data) {
  const jobs = Object.fromEntries(
    (data.jobs || []).map((job) => [job.status, Number(job.count)]),
  );
  $("repo-count").textContent = number((data.repositories || []).length);
  $("source-count").textContent = number(
    (data.sources || []).reduce((sum, source) => sum + Number(source.count), 0),
  );
  $("sync-summary").textContent =
    (jobs.running || jobs.retrying)
      ? "取り込み処理中：実行中 " + number(jobs.running || 0) + "件、再試行待ち " + number(jobs.retrying || 0) + "件。登録済みの資料は検索できます。"
      : "現在実行中の取り込み処理はありません。登録済みの資料を検索できます。";
  if (jobs.failed) $("sync-summary").textContent += " 過去の失敗が" + number(jobs.failed) + "件あります。詳細はエラー履歴を確認してください。";
  $("sync-updated").textContent =
    "最終確認 " + new Date().toLocaleTimeString("ja-JP") + " · 自動更新なし";
  const list = $("sync-error-list");
  list.replaceChildren();
  for (const error of data.errors || []) {
    const row = element("div", "sync-error-row");
    row.append(
      element("strong", "", error.error),
      element("div", "", error.updated_at),
      element("div", "", error.job),
    );
    list.append(row);
  }
  $("sync-errors").hidden = !(data.errors || []).length;
}
function safeSourceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function evidenceId(citation) {
  return "evidence-" + citation;
}
function showEvidence(index) {
  const page = Math.floor(index / RESULT_PAGE_SIZE);
  if (page !== resultPage) {
    resultPage = page;
    renderEvidencePage();
  }
  const card = $(evidenceId(resultEvidence[index].citation));
  card.focus({ preventScroll: true });
  card.scrollIntoView({ block: "start" });
}
/** Link citations to their evidence cards, including cards on other pages. */
function linkAnswerCitations(content) {
  const citationIndices = new Map(resultEvidence.map((item, index) => [item.citation, index]));
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement.closest("a, code, pre")) textNodes.push(node);
  }
  for (const node of textNodes) {
    const parts = document.createDocumentFragment();
    const text = node.textContent;
    let offset = 0;
    for (const match of text.matchAll(/\[([A-Za-z0-9_-]+)\]/g)) {
      const index = citationIndices.get(match[1]);
      if (index === undefined) continue;
      const title = resultEvidence[index].title?.trim() || "根拠資料";
      const link = element("a", "", title);
      link.href = "#" + evidenceId(match[1]);
      link.addEventListener("click", (event) => {
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) showEvidence(index);
      });
      parts.append(text.slice(offset, match.index), link);
      offset = match.index + match[0].length;
    }
    if (offset > 0) {
      parts.append(text.slice(offset));
      node.replaceWith(parts);
    }
  }
  return content;
}
/** Render the response with the question captured when the search was submitted. */
function renderResult(data, mode, query) {
  clearResults();
  $("empty-state").hidden = true;
  const evidence = Array.isArray(data.evidence) ? data.evidence : [];
  resultEvidence = evidence;
  const label = statuses[data.status] || ["結果を取得しました", ""];
  const summary = $("result-summary");
  const hitCount = "関連する本文：" + number(data.hit_count) + "件";
  summary.replaceChildren(
    element("strong", "", hitCount),
    element("span", "muted", (mode === "answer" ? "回答時間：" : "検索時間：") + (Number(data.elapsed_ms) / 1000).toFixed(2) + "秒"),
  );
  summary.hidden = false;
  if (data.status === "summarized") {
    notice("質問: " + query);
  } else if (data.status === "verification_failed") {
    notice("");
  } else {
    notice(label[0] + (label[1] ? "。" + label[1] : "。"));
  }
  if (data.status !== "retrieved") {
    const panel = $("answer-panel");
    panel.hidden = false;
    panel.append(element("h3", "", label[0]));
    panel.append(["answered", "summarized"].includes(data.status) && typeof data.answer === "string"
      ? linkAnswerCitations(markdownContent(data.answer, data.answer_html))
      : element("p", "", label[1]));
  }
  renderEvidencePage();
  const trace = Array.isArray(data.trace) ? data.trace : [];
  $("trace-panel").hidden = !trace.length;
  if (data.timings) {
    const row = element("div", "trace-row", "所要時間の内訳");
    const { scope_ms, storage_ms, model_ms, generation_ms } = data.timings;
    const parts = ["DB取得 " + number(storage_ms) + " ms", "Jev判定 " + number(model_ms) + " ms"];
    if (scope_ms) parts.unshift("公開範囲の確認 " + number(scope_ms) + " ms");
    if (generation_ms) parts.push("要約生成 " + number(generation_ms) + " ms");
    row.append(element("span", "", parts.join(" / ")));
    $("trace-list").append(row);
  }
  for (const step of trace) {
    const stageNames = { branch_screening: "検索する分野の選択", document_screening: "文書の選択", passage_scoring: "本文の評価", passage_ranking: "本文の評価と表示順の決定", shared_shortlist: "本文の再評価", choice_rerank: "表示順の決定", assess_evidence: "回答できるかの確認", generate_answer: "要約の生成", verify_answer: "回答の検証" };
    const row = element("div", "trace-row", stageNames[step.stage] || step.stage);
    row.append(
      element(
        "span",
        "",
        "候補 " +
          number(step.candidates) +
          " · API " +
          number(step.calls) +
          " 回" +
          (step.cache_hits ? " · 判定の再利用 " + number(step.cache_hits) + " 回" : "") +
          " · " +
          number(step.elapsed_ms) +
          " ms · " +
          (step.model || []).join(", "),
      ),
    );
    $("trace-list").append(row);
  }
}
/** Render a page of evidence with the full text of each retrieved passage. */
function renderEvidencePage() {
  const start = resultPage * RESULT_PAGE_SIZE;
  const end = Math.min(start + RESULT_PAGE_SIZE, resultEvidence.length);
  const pages = Math.ceil(resultEvidence.length / RESULT_PAGE_SIZE);
  $("evidence-list").replaceChildren();
  document.querySelectorAll(".result-pagination").forEach((nav) => {
    nav.hidden = pages <= 1;
    nav.querySelector("[data-page-label]").textContent = resultEvidence.length
      ? number(resultPage + 1) + " / " + number(pages) + "ページ（" + number(start + 1) + "〜" + number(end) + "件 / " + number(resultEvidence.length) + "件）"
      : "";
    nav.querySelector('[data-page-step="-1"]').disabled = resultPage === 0;
    nav.querySelector('[data-page-step="1"]').disabled = resultPage + 1 >= pages;
  });
  if (!resultEvidence.length) {
    $("evidence-list").append(
      element(
        "p",
        "muted",
        "表示できる根拠はありません。質問を変えるか、同期状況を確認してください。",
      ),
    );
  }
  for (const item of resultEvidence.slice(start, end)) {
    const card = element("article", "evidence-card");
    card.id = evidenceId(item.citation);
    card.tabIndex = -1;
    const metadata = item.metadata || {};
    const kindLabel = ({ pr: "PR", issue: "Issue", feedback: "利用者の報告", doc: "文書" })[item.kind] || item.kind;
    const numberSuffix = (item.kind === "issue" || item.kind === "pr") &&
      Number.isSafeInteger(metadata.number) && metadata.number > 0 ? " #" + metadata.number : "";
    const top = element("div", "evidence-top");
    const kindPill = element("span", "evidence-kind", kindLabel + numberSuffix);
    kindPill.dataset.kind = item.kind;
    top.append(kindPill);
    const heading = element("h3");
    const url = safeSourceUrl(item.url);
    if (url) {
      const link = element("a", "", item.title);
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      heading.append(link);
    } else heading.textContent = item.title;
    const meta = [
      item.repo,
      ({ open: "未完了", closed: "完了" })[metadata.state] || metadata.state,
      metadata.base_branch ? "→ " + metadata.base_branch : "",
      item.kind === "pr" ? (metadata.merged_at ? "マージ済み" : "未マージ") : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const details = element("div", "evidence-meta", meta);
    if (item.kind === "pr" && metadata.merged_at) {
      const release = metadata.github_release;
      const releaseUrl = safeSourceUrl(release?.url);
      details.append(" · ");
      if (releaseUrl && typeof release.tag === "string") {
        const link = element("a", "", "GitHubリリース " + release.tag + " に収録");
        link.href = releaseUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        details.append(link);
      } else {
        details.append("GitHubリリースへの収録未確認");
      }
    }
    const body = (item.text ?? "").trim();
    const empty = !body || /^\((?:no body|empty document)\)$/i.test(body);
    const excerpt = element("div", "evidence-text");
    const passage = markdownContent(empty ? "内容なし" : body, empty ? undefined : item.text_html, "evidence-excerpt", url);
    passage.tabIndex = 0;
    excerpt.append(passage);
    card.append(
      top,
      heading,
      details,
      excerpt,
    );
    $("evidence-list").append(card);
  }
}
window.addEventListener("hashchange", () => {
  const index = resultEvidence.findIndex((item) => location.hash === "#" + evidenceId(item.citation));
  if (index >= 0 && Math.floor(index / RESULT_PAGE_SIZE) !== resultPage) showEvidence(index);
});
document.querySelectorAll("[data-page-step]").forEach((button) => {
  button.addEventListener("click", () => {
    if (searching || button.disabled) return;
    const next = resultPage + Number(button.dataset.pageStep);
    if (next < 0 || next >= Math.ceil(resultEvidence.length / RESULT_PAGE_SIZE)) return;
    resultPage = next;
    renderEvidencePage();
    $("result-summary").scrollIntoView?.({ block: "start" });
    $("evidence-list").focus?.({ preventScroll: true });
  });
});
function openSettings() {
  if (!settings.open) settings.showModal();
  if (!token && !connecting) $("token").focus();
}
function askForFeedbackKey() {
  $("include-feedback").checked = false;
  feedbackRequested = true;
  openSettings();
  settingsNotice("フィードバックを検索するには、利用キーで接続してください。");
}
$("settings-button").addEventListener("click", openSettings);
settings.addEventListener("close", () => { feedbackRequested = false; });
$("include-feedback").addEventListener("change", () => {
  if ($("include-feedback").checked && !token) {
    askForFeedbackKey();
    return;
  }
  clearResults();
  notice("");
});
async function connect(candidate, restoring = false) {
  if (!candidate || connecting) return;
  const current = session;
  connecting = true;
  controls();
  settingsNotice("接続を確認しています…", "loading");
  try {
    const data = await api("/sync/status", {}, candidate);
    if (current !== session) return;
    if (restoring && readSavedToken() !== candidate) {
      settingsNotice("");
      return;
    }
    token = candidate;
    if (!restoring) saveToken(candidate);
    if (feedbackRequested && settings.open) {
      $("include-feedback").checked = true;
      clearResults();
    }
    $("token").value = "";
    $("connect-form").hidden = true;
    $("disconnect-button").hidden = false;
    $("connection-state").textContent = "接続済み";
    $("connection-state").className = "badge connected";
    renderSync(data);
    settingsNotice("");
    if (!restoring) {
      notice("接続しました。調べたいことを入力してください。");
      settings.close();
      $("query").focus();
    }
  } catch (error) {
    if (current === session) {
      settingsNotice(error.message, "error");
      if (!restoring && !settings.open) notice(error.message, "error");
    }
  } finally {
    if (current === session) {
      connecting = false;
      controls();
    }
  }
}
$("connect-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void connect($("token").value.trim());
});
$("disconnect-button").addEventListener("click", () => disconnect());
window.addEventListener("storage", (event) => {
  if (!token || event.storageArea !== localStorage) return;
  const tokenRemoved = event.key === null || (event.key === SAVED_TOKEN_KEY && event.oldValue === token);
  if (tokenRemoved && readSavedToken() !== token)
    disconnect();
});
function updateQueryCount() {
  $("query-count").textContent = number($("query").value.length) + " / 1,500文字";
}
$("query").addEventListener("input", updateQueryCount);
$("search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (searching) return;
  const queryField = $("query");
  const submittedText = queryField.value;
  const query = submittedText.trim();
  if (!query) {
    queryField.focus();
    return;
  }
  const current = session;
  const mode = $("include-summary").checked ? "answer" : "search";
  const includeFeedback = $("include-feedback").checked;
  if (includeFeedback && !token) {
    askForFeedbackKey();
    return;
  }
  searching = true;
  clearResults();
  controls();
  $("workspace").scrollTop = 0;
  notice("検索しています。しばらくお待ちください…", "loading");
  try {
    const data = await api("/" + mode, {
      method: "POST",
      body: JSON.stringify({ query, include_feedback: includeFeedback }),
    }, includeFeedback ? token : "");
    if (current === session) {
      renderResult(data, mode, query);
      if (queryField.value === submittedText) {
        queryField.value = "";
        updateQueryCount();
      }
    }
  } catch (error) {
    if (current === session) notice(error.message, "error");
  } finally {
    if (current === session) {
      searching = false;
      controls();
    }
  }
});
$("refresh-button").addEventListener("click", async () => {
  if (!token || refreshing) return;
  const current = session;
  refreshing = true;
  controls();
  try {
    const data = await api("/sync/status");
    if (current === session) {
      renderSync(data);
      settingsNotice("同期状況を更新しました。");
    }
  } catch (error) {
    if (current === session) settingsNotice(error.message, "error");
  } finally {
    if (current === session) {
      refreshing = false;
      controls();
    }
  }
});
$("sync-button").addEventListener("click", async () => {
  if (!token || syncing) return;
  const current = session;
  syncing = true;
  controls();
  try {
    await api("/sync", { method: "POST" });
    if (current === session)
      settingsNotice(
        "同期をキューに登録しました。しばらくしてから同期状況を更新してください。",
      );
  } catch (error) {
    if (current === session) settingsNotice(error.message, "error");
  } finally {
    if (current === session) {
      syncing = false;
      controls();
    }
  }
});
controls();
void connect(readSavedToken(), true);
